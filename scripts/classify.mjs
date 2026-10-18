#!/usr/bin/env node
// CLASSIFY — turn N failing visual regions into a handful of CAUSES with proposed
// fixes, so a human/agent looks at 2–3 clusters instead of every diff.png.
//
// Causes: capture-error · layout-shift · font · asset-missing · structure ·
//         color · palette-shift · unknown
//
//   node classify.mjs --visual visual-report/report.json [--pairs pairs.json] [--spec spec/spec.json]
import path from 'node:path';
import fs from 'node:fs';
import {
  parseArgs, num, str, flag, readJsonSafe, writeJson, rel, usage, summary, stamp, round, colorDistance, parseColor, contrast,
} from './lib/core.mjs';
import { loadImage, regionVariance } from './lib/img.mjs';

const A = parseArgs();
const visual = readJsonSafe(path.resolve(str(A.visual, 'visual-report/report.json')));
if (!visual) usage('Usage: node classify.mjs --visual visual-report/report.json [--pairs pairs.json] [--spec spec/spec.json]');
const pairsCfg = A.pairs ? readJsonSafe(path.resolve(String(A.pairs))) : undefined;
const spec = A.spec ? readJsonSafe(path.resolve(String(A.spec))) : undefined;
const outPath = path.resolve(str(A.out, 'visual-report/classify.json'));

const PAIR_BY_KEY = new Map((pairsCfg?.pairs ?? []).map((p) => [`${p.name}@${p.width}`, p]));

function fixFor(cause, evidence) {
  switch (cause) {
    case 'capture-error':
      return 'Fix the capture, not the CSS: same selector on both sides, same viewport width, non-zero stable box.';
    case 'layout-shift':
      return `Content is displaced by ${evidence.dx},${evidence.dy}px. Check alignment/justify/order of the displaced block and the container\'s padding — do not "eyeball"; re-measure the container box.`;
    case 'font':
      return 'Text metrics differ: verify the exact font file is loaded (font check + document.fonts), weight is real (font-synthesis: none), and font-size/letter-spacing/line-height match the spec. Do not change the copy.';
    case 'asset-missing':
      return 'The build has flat/no content where the reference has structure → substitute with a real placeholder that keeps composition (DOM block with the same headline/CTA geometry + neutral art), not a plain rectangle.';
    case 'structure':
      return 'A large region differs: compare children counts and the grid/flex definition (columns, gaps, order). Use `digest.mjs --width <w> --region` on both sides.';
    case 'color':
      return `Colour is wrong in this region (${evidence.refColor} → ${evidence.buildColor}). Fix the token, not the individual rule; then re-check contrast.`;
    case 'palette-shift':
      return `Subtle tint/contrast drift (${evidence.refColor} → ${evidence.buildColor}). Usually a background layering or opacity issue — check the nearest painted ancestor.`;
    default:
      return 'Unclassified: open the diff image for this region (contact sheet index has the exact crop) and describe the change before editing.';
  }
}

async function classifyRegion(pair, region) {
  const evidence = { clusters: region.clusters?.length ?? 0 };
  if (!region.ok || region.cause === 'capture-error') return { cause: 'capture-error', confidence: 1, evidence: { note: region.note }, fix: fixFor('capture-error') };
  const clusters = region.clusters ?? [];
  if (!clusters.length) return { cause: 'unknown', confidence: 0.2, evidence, fix: `Diff is ${region.diffPct}% but no cluster >= 1 cell was isolated (sub-cell noise / antialiasing). Compare the diff image before editing.` };

  const cfg = PAIR_BY_KEY.get(`${region.name}@${region.width}`);
  let refImg, buildImg;
  if (cfg) {
    refImg = await loadImage(path.resolve(cfg.ref));
    buildImg = await loadImage(path.resolve(cfg.build));
  }
  const top = clusters[0];
  evidence.top = top;
  const areas = clusters.map((c) => c.areaShare);
  const totalShare = round(areas.reduce((a, b) => a + b, 0), 2);
  const bands = clusters.filter((c) => c.shape === 'band');
  const dense = clusters.filter((c) => c.density > 25);
  const big = clusters.find((c) => c.areaShare >= 25);
  const dists = clusters.map((c) => c.meanDistance);
  const meanDist = dists.reduce((a, b) => a + b, 0) / dists.length;

  // 1) pure displacement is the most actionable and most common
  if (region.shift && region.shift.improvement > 25 && Math.max(Math.abs(region.shift.dx), Math.abs(region.shift.dy)) >= 2) {
    return { cause: 'layout-shift', confidence: round(region.shift.improvement / 100, 2), evidence: { ...evidence, ...region.shift }, fix: fixFor('layout-shift', region.shift) };
  }
  // 2) flat/blank where structure exists → missing or placeholder asset
  if (refImg?.img && buildImg?.img) {
    const rv = regionVariance(refImg, top.bbox);
    const bv = regionVariance(buildImg, top.bbox);
    evidence.variance = { ref: rv.sd, build: bv.sd };
    if (rv.sd > 10 && bv.sd < rv.sd * 0.4 && (top.areaShare >= 4 || totalShare >= 8)) {
      return { cause: 'asset-missing', confidence: 0.7, evidence, fix: fixFor('asset-missing') };
    }
    if (Math.abs(rv.mean - bv.mean) > 6 && bv.sd < 6 && rv.sd < 6) {
      return { cause: 'palette-shift', confidence: 0.6, evidence: { ...evidence, refColor: top.refColor, buildColor: top.buildColor }, fix: fixFor('palette-shift', top) };
    }
  }
  // 3) many horizontal bands with high density → text/font metrics
  if (bands.length >= 2 && bands.length >= clusters.length * 0.5 && dense.length >= 1) {
    const specFonts = (spec?.tokens?.fonts ?? []).map((f) => `${f.family} ${f.weight}`);
    return { cause: 'font', confidence: 0.65, evidence: { ...evidence, bands: bands.length, specFonts }, fix: fixFor('font') };
  }
  // 4) one dominant block → structural/compositional
  if (big && big.areaShare >= 25) {
    const structural = big.density < 25;
    return { cause: structural ? 'structure' : 'color', confidence: 0.55, evidence, fix: fixFor(structural ? 'structure' : 'color', big) };
  }
  // 5) colour-only change
  const sameShape = clusters.every((c) => c.density > 60);
  if (meanDist > 120 && sameShape) return { cause: 'color', confidence: 0.6, evidence: { ...evidence, meanDist }, fix: fixFor('color', top) };
  if (meanDist < 90 && sameShape) return { cause: 'palette-shift', confidence: 0.5, evidence: { ...evidence, meanDist }, fix: fixFor('palette-shift', top) };
  return { cause: 'unknown', confidence: 0.3, evidence, fix: fixFor('unknown', top) };
}

const regions = [];
for (const region of visual.results ?? []) {
  if (region.pass) continue;
  const c = await classifyRegion(region, region);
  regions.push({ name: region.name, width: region.width, diffPct: region.diffPct, ...c });
}

const byCause = {};
for (const r of regions) { byCause[r.cause] ??= []; byCause[r.cause].push(`${r.name}@${r.width}`); }
const report = {
  at: stamp(), source: rel(path.resolve(str(A.visual, 'visual-report/report.json')), process.cwd()),
  regions, byCause, fixOrder: Object.entries(byCause).sort((a, b) => b[1].length - a[1].length).map(([cause, list]) => ({ cause, count: list.length, regions: list, fix: fixFor(cause, (regions.find((r) => r.cause === cause)?.evidence?.top) ?? {}) })),
};
writeJson(outPath, report);

summary('classify', { regions: regions.length, causes: Object.fromEntries(Object.entries(byCause).map(([k, v]) => [k, v.length])), out: rel(outPath, process.cwd()) });
if (!flag(A.quiet)) {
  for (const [cause, list] of Object.entries(byCause).sort((a, b) => b[1].length - a[1].length)) {
    const first = regions.find((r) => r.cause === cause);
    console.log(`  ${cause} (${list.length}) — ${list.slice(0, 4).join(', ')}${list.length > 4 ? '…' : ''}`);
    console.log(`      fix: ${first.fix}`);
  }
  if (!regions.length) console.log('  (nothing failing — no clusters to classify)');
}
