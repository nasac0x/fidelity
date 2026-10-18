#!/usr/bin/env node
// VISUAL-DIFF — compare reference element shots against build element shots.
// Deterministic scorer (grid cells + clusters, mask-aware) with odiff/pixelmatch
// as cross-checks, an ANNOTATED diff image per region, and ONE contact sheet for
// every pair, so the agent reads a single image instead of N.
//
//   node visual-diff.mjs --pairs pairs.json --out visual-report
// pairs.json:
// { "pairs": [{ "name":"hero","width":1366,"ref":"import/element-1366-hero.png","build":"report/element-1366-hero.png" }],
//   "masks": { "hero@1366": [{"x":0,"y":0,"w":600,"h":378,"reason":"substituted art"}] },
//   "thresholdPct": 3, "odiffThreshold": 0.1, "cell": 16, "tolerance": 30 }
import fs from 'node:fs';
import path from 'node:path';
import { compare as odiffCompare } from 'odiff-bin';
import {
  parseArgs, num, str, flag, readJsonSafe, writeJson, writeText, ensureDir, rmrf, rel,
  usage, summary, stamp, round, humanBytes,
} from './lib/core.mjs';
import { loadImage, gridDiff, findBestShift, regionVariance, pixelmatchScore, contactSheet, drawRect, drawLabel, getFont, fitWidth } from './lib/img.mjs';

const A = parseArgs();
const pairsPath = str(A.pairs, 'pairs.json');
const config = readJsonSafe(path.resolve(pairsPath));
if (!config) usage('Usage: node visual-diff.mjs --pairs pairs.json --out visual-report/');
const outDir = path.resolve(str(A.out, 'visual-report'));
rmrf(outDir);
ensureDir(outDir);

const thresholdPct = num(A.threshold, config.thresholdPct ?? 3);
const tolerance = num(A.tolerance, config.tolerance ?? 30);
const cell = num(A.cell, config.cell ?? 16);
const wantSheet = flag(A.contactSheet) || config.contactSheet !== false;
const wantClusters = flag(A.clusters) || config.clusters !== false;

await getFont('w16').catch(() => { });
await getFont('b16').catch(() => { });

const results = [];
const tiles = [];

for (const pair of config.pairs ?? []) {
  const base = { name: pair.name, width: pair.width, ref: pair.ref, build: pair.build };
  const refPath = path.resolve(pair.ref ?? '');
  const buildPath = path.resolve(pair.build ?? '');
  if (!fs.existsSync(refPath) || !fs.existsSync(buildPath)) {
    results.push({ ...base, ok: false, pass: false, diffPct: null, cause: 'capture-error', note: `missing file (${!fs.existsSync(refPath) ? pair.ref : pair.build}) — capture element shots on BOTH sides first: extract.mjs --shots + validate elementShots` });
    continue;
  }
  const ref = await loadImage(refPath);
  const build = await loadImage(buildPath);
  if (ref.error || build.error) {
    results.push({ ...base, ok: false, pass: false, diffPct: null, cause: 'capture-error', note: `unreadable: ref=${ref.error ?? 'ok'} build=${build.error ?? 'ok'}` });
    continue;
  }
  if (ref.w !== build.w || ref.h !== build.h) {
    results.push({
      ...base, ok: false, pass: false, diffPct: null, cause: 'capture-error',
      note: `size mismatch: ref ${ref.w}×${ref.h} vs build ${build.w}×${build.h} — wrong selector or wrong viewport; fix the capture, not the mask`,
    });
    continue;
  }
  const masks = (config.masks?.[`${pair.name}@${pair.width}`] ?? []).map((m) => ({ ...m }));
  const gd = gridDiff(ref, build, { cell, tolerance, mask: masks });
  const shift = gd.diffPct > 0.05 ? findBestShift(ref, build, { mask: masks, maxShift: num(A.maxShift, 48) }) : { dx: 0, dy: 0, improvement: 0 };

  // diff image (pixelmatch) with cluster boxes drawn on top
  let diffOut = path.join(outDir, `${pair.name}@${pair.width}.diff.png`);
  let diffNote = '';
  try {
    const pm = pixelmatchScore(ref, build, diffOut, { threshold: config.odiffThreshold ?? 0.1, mask: masks });
    if (pm.sizeMismatch) throw new Error(pm.sizeMismatch);
    const img = pm.png();
    if (pm.diffCount === 0) {
      drawLabel(img, 'identical — 0 differing pixels', 6, 6, { color: 0x000000ff, bg: 0x7ee787ff });
    }
    for (const [i, c] of (wantClusters ? gd.clusters.slice(0, 6) : []).entries()) {
      drawRect(img, c.bbox, 0xff3b30ff, 2);
      drawLabel(img, `${i + 1} ${c.shape} ${c.refColor}→${c.buildColor}`, c.bbox.x + 2, c.bbox.y + 2, { color: 0xffffffff, bg: 0x000000cc });
    }
    await img.write(diffOut);
    diffNote = 'pixelmatch';
  } catch (err) {
    diffNote = `pixelmatch failed (${String(err).slice(0, 60)})`;
    try {
      const res = await odiffCompare(refPath, buildPath, diffOut, { antialiasing: true, outputDiffMask: true, threshold: config.odiffThreshold ?? 0.1, ignoreRegions: masks });
      diffNote = `odiff (${res.match ? 'match' : res.reason})`;
    } catch (err2) { diffNote = 'no diff image'; }
  }

  const clusters = gd.clusters.slice(0, 8);
  const pass = gd.diffPct <= thresholdPct;
  results.push({
    ...base, ok: true, pass, diffPct: gd.diffPct, diffPixels: gd.diffPixels,
    masks: masks.length, maskedPixels: gd.maskedPixels,
    shift: shift.improvement > 10 ? { dx: shift.dx, dy: shift.dy, improvement: shift.improvement } : undefined,
    clusters: wantClusters ? clusters : undefined,
    refSize: `${ref.w}×${ref.h}`, diffImage: rel(diffOut, process.cwd()), diffNote,
    cause: pass ? undefined : 'unclassified',
  });
  tiles.push({ label: `${pair.name}@${pair.width} — ${gd.diffPct}% ${pass ? '✅' : '❌'}${masks.length ? ` (${masks.length} mask)` : ''}`, images: [{ name: 'ref', src: refPath }, { name: 'build', src: buildPath }, { name: 'diff', src: diffOut }] });
}

let sheetPath;
if (wantSheet && tiles.length) {
  sheetPath = path.join(outDir, 'contact-sheet.png');
  const index = await contactSheet({ tiles, out: sheetPath, cols: num(A.cols, tiles.length === 1 ? 1 : 2), tileWidth: num(A.tileWidth, 560) });
  writeJson(path.join(outDir, 'contact-sheet.json'), index);
}

const failed = results.filter((r) => !r.pass);
const md = [];
md.push(`# Visual diff — ${stamp()}`, '');
md.push(`**${results.length - failed.length}/${results.length} regions passed** (threshold ${thresholdPct}% unmasked, tolerance ${tolerance} Δcolor, cell ${cell}px).`);
if (sheetPath) md.push('', `Contact sheet: \`${rel(sheetPath, process.cwd())}\` — read THIS single image first (index in contact-sheet.json).`);
md.push('');
if (failed.length) {
  md.push('## Failures', '', '| region | width | diff % | shift | top clusters (bbox · shape · colour) | note |', '|---|---|---|---|---|---|');
  for (const r of failed) {
    const cl = (r.clusters ?? []).slice(0, 3).map((c) => `${c.bbox.x},${c.bbox.y} ${c.bbox.w}×${c.bbox.h} ${c.shape} ${c.refColor}→${c.buildColor} ${c.areaShare}%`).join('<br>');
    md.push(`| ${r.name} | ${r.width} | ${r.diffPct} | ${r.shift ? `Δ${r.shift.dx},${r.shift.dy}px (−${r.shift.improvement}%)` : '—'} | ${cl || '—'} | ${r.cause} · ${r.note ?? ''} |`);
  }
  md.push('');
}
if (Object.keys(config.masks ?? {}).length) {
  md.push('## Exclusion masks (intentionally substituted)', '');
  for (const [key, list] of Object.entries(config.masks)) md.push(`- \`${key}\`: ${list.map((m) => `[${m.x},${m.y} ${m.w}×${m.h}] ${m.reason ?? ''}`).join('; ')}`);
  md.push('', 'Masked regions are excluded from the verdict and listed here so the exclusion stays auditable.', '');
}
md.push('## All regions', '', '| region | width | diff % | size | masks | diff image |', '|---|---|---|---|---|---|');
for (const r of results) md.push(`| ${r.name} | ${r.width} | ${r.diffPct ?? '—'} | ${r.refSize ?? '—'} | ${r.masks ?? 0} | ${r.diffImage ? `\`${rel(path.resolve(r.diffImage), outDir)}\`` : r.note ?? '—'} |`);
writeText(path.join(outDir, 'report.md'), md.join('\n') + '\n');
writeJson(path.join(outDir, 'report.json'), {
  at: stamp(), pairs: rel(path.resolve(pairsPath), process.cwd()), thresholdPct, tolerance, cell,
  totals: { regions: results.length, passed: results.length - failed.length, failed: failed.length },
  sheet: sheetPath ? rel(sheetPath, process.cwd()) : undefined,
  results,
});
writeJson(path.join(outDir, 'gate.json'), { ok: failed.length === 0, failed: failed.length, regions: results.length, sheet: sheetPath ? rel(sheetPath, process.cwd()) : undefined, at: stamp() });

if (flag(A.json)) summary('visual-diff', { ok: failed.length === 0, failed: failed.length, regions: results.length, out: rel(outDir, process.cwd()) });
else {
  console.log(`visual-diff: ${results.length - failed.length}/${results.length} regions passed, ${failed.length} failed (threshold ${thresholdPct}%)`);
  for (const r of failed) {
    const cl = (r.clusters ?? []).slice(0, 3).map((c) => `${c.shape}@${c.bbox.x},${c.bbox.y} ${c.bbox.w}×${c.bbox.h} ${c.refColor}→${c.buildColor} (${c.areaShare}%)`);
    console.log(`  ✗ ${r.name}@${r.width}  ${r.diffPct ?? '?'}%${r.shift ? `  shift Δ${r.shift.dx},${r.shift.dy}px (−${r.shift.improvement}%)` : ''}${r.note ? `  ${r.note}` : ''}`);
    for (const c of cl) console.log(`      · ${c}`);
  }
  if (sheetPath) console.log(`sheet  → ${rel(sheetPath, process.cwd())}  (read this one image first)`);
  console.log(`report → ${rel(path.join(outDir, 'report.md'), process.cwd())}`);
  console.log(`next   → node classify.mjs --visual ${rel(path.join(outDir, 'report.json'), process.cwd())}`);
}
process.exit(failed.length ? 1 : 0);
