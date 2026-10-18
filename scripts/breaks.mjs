#!/usr/bin/env node
// BREAKS — infer the reference's REAL breakpoints instead of guessing.
//   1. scan every stylesheet's @media conditions (min/max-width)
//   2. probe a dense width ladder, fingerprinting the layout at each width
//   3. bisect every layout jump down to the exact pixel
//   4. emit a validation ladder (boundary-1 / boundary / boundary+1)
//
//   node breaks.mjs --url http://localhost:3000 --out import/breaks.json
//   node breaks.mjs --url ... --from 320 --to 2040 --step 40 --ladder-only
import path from 'node:path';
import { parseArgs, num, str, flag, csv, loadConfig, writeJson, usage, summary, rel, round } from './lib/core.mjs';
import { withBrowser, newPage, prepare, layoutSignature } from './lib/browser.mjs';

const A = parseArgs();
const url = str(A.url, A._[0]);
if (!url) usage('Usage: node breaks.mjs --url <URL> [--out breaks.json] [--from 320] [--to 2040] [--step 40] [--jump 4] [--landmarks "sel;;sel"]');
const cfg = loadConfig(A);
const from = num(A.from, 320), to = num(A.to, 2040), step = num(A.step, 40);
const jumpPx = num(A.jump, 6);
const landmarks = csv(str(A.landmarks), String);
const outPath = A.out ? path.resolve(String(A.out)) : null;

/* ---------------------------------------------------------- detection --- */
// A layout is a mix of CONTINUOUS facts (positions/sizes that follow the
// viewport, e.g. clamp()) and DISCRETE ones (a column appears, a nav hides, a
// font-size steps at a @media). A fixed tolerance flags every fluid step, and a
// global median misses steps in regions where the feature is otherwise still.
// So the baseline is LOCAL: a step counts only when a feature moves much more
// at that width than it does at the neighbouring widths.

const colsCount = (v) => String(v ?? '').trim().split(/\s+/).filter(Boolean).length;

/** Flatten a signature into `num` (comparable magnitudes) + `cat` (categories). */
function features(sig) {
  const num = new Map(), cat = new Map();
  num.set('page.scrollHeight', sig.scrollHeight);
  num.set('page.scrollWidth', sig.scrollWidth);
  for (const [k, p] of Object.entries(sig.landmarks)) {
    if (!p) { cat.set(`lm.${k}`, 'absent'); continue; }
    cat.set(`lm.${k}`, 'present');
    cat.set(`${k}.vis`, p.w > 0 && p.h > 0 ? 'shown' : 'hidden');
    for (const f of ['x', 'y', 'w', 'h']) num.set(`${k}.${f}`, p[f]);
    num.set(`${k}.fs`, Number.parseFloat(p.fs) || 0);
    cat.set(`${k}.dir`, p.dir);
    cat.set(`${k}.disp`, p.disp);
    cat.set(`${k}.cols`, String(colsCount(p.cols)));
  }
  sig.textNodes.forEach((n, i) => {
    num.set(`t${i}.x`, n.x); num.set(`t${i}.y`, n.y); num.set(`t${i}.w`, n.w);
    num.set(`t${i}.fs`, Number.parseFloat(n.fs) || 0);
    cat.set(`t${i}.vis`, n.w > 0 ? 'shown' : 'hidden');
    cat.set(`t${i}.text`, n.t);
  });
  return { num, cat };
}

const median = (arr) => { const s = arr.filter((n) => Number.isFinite(n)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Per-ladder-step deltas: `{d}` per numeric feature, `{cat:true}` per change. */
function deltaSeries(flats) {
  const steps = [];
  for (let i = 1; i < flats.length; i++) {
    const m = new Map();
    for (const [k, v] of flats[i].f.num) {
      const prev = flats[i - 1].f.num.get(k);
      if (prev === undefined) continue;
      m.set(k, { d: Math.abs(v - prev), from: prev, to: v });
    }
    for (const [k, v] of flats[i].f.cat) {
      const prev = flats[i - 1].f.cat.get(k);
      if (prev !== undefined && prev !== v) m.set(k, { cat: true, from: prev, to: v });
    }
    steps.push(m);
  }
  return steps;
}

/** Drift of one feature around step `i`, from its neighbours. */
function localOf(steps, i, k) {
  const nb = [];
  for (const j of [i - 2, i - 1, i + 1, i + 2]) {
    const e = steps[j]?.get(k);
    if (e && Number.isFinite(e.d)) nb.push(e.d);
  }
  return median(nb);
}

/** A regime change is layout/typography; a reflow is text wrapping differently. */
const REGIME_KEY = /\.(cols|dir|disp|fs)$/;
const severityOf = (hits) => (hits.some((h) => h.kind === 'cat' || REGIME_KEY.test(h.key) || (h.delta ?? 0) >= 60) ? 'regime' : 'reflow');

/** Features that beat their local baseline at step `i`. */
function hitsAt(steps, i) {
  const hits = [];
  for (const [k, e] of steps[i]) {
    if (e.cat) { hits.push({ key: k, kind: 'cat', from: e.from, to: e.to, delta: null }); continue; }
    const local = localOf(steps, i, k);
    const thr = round(Math.max(jumpPx, local * 2, local + 4), 1);
    if (e.d > thr) hits.push({ key: k, kind: 'num', from: round(e.from, 1), to: round(e.to, 1), delta: round(e.d, 1), local: round(local, 1), threshold: thr });
  }
  return hits;
}

/** Same test, but for an interval of `span` px (drift scales with the span). */
function hitsBetween(loF, midF, seed, span) {
  const hits = [];
  for (const h of seed) {
    if (h.kind === 'cat') {
      const a = loF.cat.get(h.key), b = midF.cat.get(h.key);
      if (a !== undefined && a !== b) hits.push({ ...h, from: a, to: b });
      continue;
    }
    const a = loF.num.get(h.key), b = midF.num.get(h.key);
    if (a === undefined || b === undefined) continue;
    const local = h.local ?? 0;
    const thr = Math.max(jumpPx, local * 2 * (span / step), local + 4);
    if (Math.abs(b - a) > thr) hits.push({ ...h, from: round(a, 1), to: round(b, 1), delta: round(Math.abs(b - a), 1) });
  }
  return hits;
}
const fmtHits = (hits) => hits.slice(0, 3).map((h) => (h.kind === 'cat' ? `${h.key}: ${h.from}→${h.to}` : `${h.key} Δ${h.delta}px (${h.from}→${h.to})`)).join('; ');

const mediaQueries = [];
const jumps = [];
const ladder = new Set([from, to]);
let scan = { widths: [], raw: [], sheets: 0, blocked: 0 };
let detection = { steps: 0, outliers: 0, calibrated: 0, thresholdFloorPx: jumpPx };

await withBrowser(async (browser) => {
  const { page, context } = await newPage(browser, { ...cfg, width: from });
  await prepare(page, { url, timeoutMs: cfg.timeoutMs, settleMs: Math.min(cfg.settleMs, 700), scrollThrough: true });
  await page.waitForTimeout(300);

  // 1) stylesheet scan
  scan = await page.evaluate(() => {
    const found = { widths: [], raw: [], sheets: 0, blocked: 0 };
    const add = (cond) => {
      found.raw.push(cond);
      const re = /\(\s*(min|max)-width\s*:\s*([\d.]+)\s*(px|em|rem)\s*\)/gi;
      let m;
      while ((m = re.exec(cond))) {
        let v = Number(m[2]);
        if (/em|rem/i.test(m[3])) v *= 16;
        found.widths.push({ kind: m[1].toLowerCase(), px: Math.round(v), raw: m[0] });
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { found.blocked++; continue; }
      if (!rules) continue;
      found.sheets++;
      const walk = (list) => {
        for (const r of Array.from(list ?? [])) {
          if (r.media) { if (typeof r.media.mediaText === 'string') add(r.media.mediaText); else for (const m of Array.from(r.media)) add(m.mediaText); }
          if (r.cssRules) walk(r.cssRules);
        }
      };
      walk(rules);
    }
    return found;
  });
  mediaQueries.push(...scan.widths);

  // 2) dense probe
  const sigs = [];
  for (let w = from; w <= to; w += step) {
    await page.setViewportSize({ width: w, height: cfg.height });
    await page.waitForTimeout(num(A.pause, 220));
    sigs.push({ w, sig: await layoutSignature(page, landmarks) });
  }

  // 3) jumps: a breakpoint is where a feature beats its LOCAL drift, and the
  //    exact pixel is found by bisection (never "any pixel that moved").
  const flats = sigs.map((s) => ({ w: s.w, sig: s.sig, f: features(s.sig) }));
  const series = deltaSeries(flats);
  const candidates = [];
  for (let i = 0; i < series.length; i++) {
    const hits = hitsAt(series, i);
    if (hits.length) candidates.push({ from: flats[i], to: flats[i + 1], hits, severity: severityOf(hits) });
  }
  detection = { steps: series.length, outliers: candidates.length, features: flats[0]?.f.num.size ?? 0, thresholdFloorPx: jumpPx };

  // Bisect EACH feature separately, then group by pixel: a text reflow and a
  // @media step often land in the same 40px step, and a single bisection would
  // stop at whichever came first and hide the real breakpoint.
  const cache = new Map();
  const measure = async (w) => {
    if (cache.has(w)) return cache.get(w);
    await page.setViewportSize({ width: w, height: cfg.height });
    await page.waitForTimeout(num(A.pause, 220));
    const f = features(await layoutSignature(page, landmarks));
    cache.set(w, f);
    return f;
  };
  for (const c of candidates) {
    const grouped = new Map();
    for (const seed of c.hits) {
      let lo = c.from.w, hi = c.to.w;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const hits = hitsBetween(c.from.f, await measure(mid), [seed], mid - lo);
        if (hits.length) hi = mid; else lo = mid;
      }
      if (!grouped.has(hi)) grouped.set(hi, []);
      grouped.get(hi).push(seed);
    }
    for (const [boundary, hits] of grouped) {
      jumps.push({
        boundary, between: [c.from.w, c.to.w], fromWidth: c.from.w, toWidth: c.to.w, source: 'probe',
        severity: severityOf(hits), why: fmtHits(hits),
        hits: hits.map((h) => ({ key: h.key, from: h.from, to: h.to, delta: h.delta, kind: h.kind })),
      });
    }
  }
  detection.probedWidths = cache.size;
  await context.close();
});

// 4) ladder: regime boundaries (layout/typography) + media queries. Text reflow
//    points are reported but left out: they are consequences of a fluid layout,
//    not decisions a designer made, and every extra width costs a capture.
//    Boundaries closer than one probe step are one event (a fluid cascade makes
//    several grids reflow within a few pixels) — cluster them and keep a single
//    representative width, preferring the exact @media pixel when there is one.
const regime = jumps.filter((j) => j.severity === 'regime').map((j) => j.boundary).sort((a, b) => a - b);
const clusterList = [];
for (const p of regime) {
  const last = clusterList[clusterList.length - 1];
  if (last && p - last.max <= step) { last.max = p; last.px.push(p); }
  else clusterList.push({ min: p, max: p, px: [p] });
}
const mqPixels = mediaQueries.map((m) => (m.kind === 'min' ? m.px : m.px + 1));
const boundaries = clusterList.map((c) => mqPixels.find((v) => v >= c.min - 2 && v <= c.max + 2) ?? c.min).sort((a, b) => a - b);
for (const b of boundaries) { ladder.add(b - 1); ladder.add(b); ladder.add(b + 1); }
for (const mq of mediaQueries) {
  const v = mq.kind === 'min' ? mq.px : mq.px + 1; // min-width:N ⇒ N is the first desktop px
  if (v >= from - 2 && v <= to + 2) { ladder.add(v - 1); ladder.add(v); }
}
const ladderArr = [...ladder].filter((w) => w >= from - 1 && w <= to + 1 && w > 0).sort((a, b) => a - b);

const result = {
  url, probedAt: new Date().toISOString(),
  range: { from, to, step },
  detection,
  mediaQueries: mediaQueries.filter((m, i, all) => all.findIndex((x) => x.px === m.px && x.kind === m.kind) === i).sort((a, b) => a.px - b.px),
  mediaQueriesRaw: [...new Set(scan.raw ?? [])],
  stylesheetScan: { sheets: scan.sheets ?? 0, blockedByCors: scan.blocked ?? 0 },
  jumps,
  regimeBoundaries: boundaries,
  regimeClusters: clusterList.map((c) => ({ representative: mqPixels.find((v) => v >= c.min - 2 && v <= c.max + 2) ?? c.min, pixels: c.px })),
  reflowPoints: [...new Set(jumps.filter((j) => j.severity === 'reflow').map((j) => j.boundary))].sort((a, b) => a - b),
  boundaries,
  ladder: ladderArr,
  notes: [
    scan.blocked ? `${scan.blocked} stylesheet(s) could not be read (CORS) — breakpoints come from probing only.` : null,
    `detection: local baselines (a step counts only when a feature moves much more there than at the neighbouring widths; floor ${jumpPx}px), then bisection per feature.`,
    'regimeBoundaries = layout/typography decisions (they build the ladder); regimes within one probe step are clustered; reflowPoints = text wrapping differently (reported, not captured).',
    boundaries.length ? null : 'No layout jumps detected in range: the page is (nearly) fluid; keep the default width ladder.',
  ].filter(Boolean),
};
if (outPath) {
  writeJson(outPath, result);
  summary('breaks', { out: rel(outPath, process.cwd()), boundaries, ladder: ladderArr.length, mediaQueries: result.mediaQueries.length, regime: boundaries.length, reflow: result.reflowPoints.length, probed: jumps.length });
}
if (flag(A.ladderOnly) || !outPath) {
  console.log(`regime boundaries: ${boundaries.join(', ') || '(none)'}`);
  console.log(`ladder: ${ladderArr.join(',')}`);
  for (const j of jumps) console.log(`  ${j.severity === 'regime' ? '▸' : '·'} @${j.boundary}px  ← ${j.why}`);
  for (const m of result.mediaQueries) console.log(`  @media ${m.kind}-width:${m.px}px → ${m.raw}`);
}
if (!outPath && !flag(A.ladderOnly)) process.exit(0);
