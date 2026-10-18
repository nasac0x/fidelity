// lib/scale.mjs — the scale solver: turn per-width measurements into fluid CSS.
//
// Given measurements of one property at several viewports, decide whether it is
//   constant      → 14px
//   fluid         → clamp(24px, calc(-46.7px + 9.87vw), 88.649px)
//   stepped       → media-query overrides at the widths where it really jumps
// and always keep the raw evidence line so a human can audit the math.
import { round, contrast, wcagLevel, parseColor } from './core.mjs';

export const fmt = (v, d = 2) => {
  const n = round(v, d);
  return String(Number.isInteger(n) ? n : n);
};
export function parsePx(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(-?[\d.]+)px$/);
  return m ? Number(m[1]) : null;
}

/** Least squares on (w, value) → {a, b, r2, maxResidual}. */
function linfit(pts) {
  const n = pts.length;
  const sw = pts.reduce((s, p) => s + p.w, 0);
  const sv = pts.reduce((s, p) => s + p.v, 0);
  const mw = sw / n, mv = sv / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.w - mw) * (p.v - mv); den += (p.w - mw) ** 2; }
  const b = den === 0 ? 0 : num / den;
  const a = mv - b * mw;
  let sse = 0, sst = 0, maxRes = 0;
  for (const p of pts) {
    const e = p.v - (a + b * p.w);
    sse += e * e; sst += (p.v - mv) ** 2;
    maxRes = Math.max(maxRes, Math.abs(e));
  }
  return { a, b, r2: sst === 0 ? 1 : 1 - sse / sst, maxResidual: maxRes };
}

/**
 * @param points [{w, value}] — px values measured at viewport widths
 * @returns {{kind, css, media, evidence, notes, residual}}
 */
export function solveScale(points, { tolPx = 2, minR2 = 0.985, minSlope = 0.005 } = {}) {
  const pts = [];
  const seen = new Map();
  for (const p of points) {
    const v = parsePx(p.value ?? p.px);
    if (v === null || !Number.isFinite(p.w)) continue;
    seen.set(Number(p.w), v);
  }
  for (const [w, v] of [...seen.entries()].sort((a, b) => a[0] - b[0])) pts.push({ w, v });
  const notes = [];
  const evidence = pts.map((p) => `${p.w}:${fmt(p.v, 2)}px`).join(' ');
  if (!pts.length) return { kind: 'unknown', css: null, media: [], evidence, notes: ['no measurable samples'], residual: null };
  if (pts.length === 1) return { kind: 'constant', css: `${fmt(pts[0].v, 3)}px`, media: [], evidence, notes: ['single width measured'], residual: 0 };

  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  if (max - min <= 0.5) return { kind: 'constant', css: `${fmt(min, 3)}px`, media: [], evidence, notes: [], residual: round(max - min, 3) };

  // ---- clamped-linear: fluid between a real min and max ----
  // Pages write `clamp(48px, 8vw, 96px)`: the interior samples sit on a line
  // while the extremes are flat. Fitting all samples gets a slope that is wrong
  // everywhere (and a min taken from the first fitted sample, not the real one),
  // so fit the interior only and then verify clamp(lo, line, hi) reproduces
  // EVERY measurement.
  const lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  const interior = pts.filter((p) => p.v > lo + 0.5 && p.v < hi - 0.5);
  if (interior.length >= 2) {
    const f = linfit(interior);
    if (f.b > minSlope && f.r2 >= minR2) {
      const pred = pts.map((p) => Math.min(hi, Math.max(lo, f.a + f.b * p.w)));
      const dev = Math.max(...pred.map((v, i) => Math.abs(v - pts[i].v)));
      if (dev <= tolPx) {
        const mid = Math.abs(f.a) < 0.01 ? `${fmt(f.b * 100, 3)}vw` : `calc(${fmt(f.a, 2)}px + ${fmt(f.b * 100, 3)}vw)`;
        const css = `clamp(${fmt(lo, 3)}px, ${mid}, ${fmt(hi, 3)}px)`;
        return {
          kind: 'fluid-clamped', css, media: [], evidence,
          notes: [`line fitted on ${interior.length} interior samples, clamped to the measured min/max`, `max residual ${round(dev, 2)}px`],
          residual: round(dev, 2), fluidRange: [pts[0].w, pts.at(-1).w],
        };
      }
    }
  }

  // ---- fluid: longest consecutive run that fits a line with a real slope ----
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    for (let j = pts.length - 1; j - i >= 2; j--) {
      const run = pts.slice(i, j + 1);
      if (run.at(-1).w - run[0].w < 40) continue;
      const f = linfit(run);
      if (f.b <= minSlope) continue;
      if (f.r2 < minR2 || f.maxResidual > Math.max(tolPx, max * 0.02)) continue;
      const len = run.length, span = run.at(-1).w - run[0].w;
      if (!best || len > best.len || (len === best.len && span > best.span)) best = { ...f, run, len, span };
    }
  }
  if (best) {
    const lo = fmt(best.run[0].v, 3), hi = fmt(best.run.at(-1).v, 3);
    const css = `clamp(${lo}px, calc(${fmt(best.a, 2)}px + ${fmt(best.b * 100, 3)}vw), ${hi}px)`;
    if (best.run.length < pts.length) notes.push(`fluid fit uses ${best.run.length}/${pts.length} samples (${best.run[0].w}–${best.run.at(-1).w}px); the rest are clamped`);
    notes.push(`r²=${round(best.r2, 4)} maxResidual=${round(best.maxResidual, 2)}px`);
    return { kind: 'fluid', css, media: [], evidence, notes, residual: round(best.maxResidual, 2), fluidRange: [best.run[0].w, best.run.at(-1).w] };
  }

  // ---- stepped: consecutive equal values become ranges ----
  const steps = [];
  for (const p of pts) {
    const last = steps.at(-1);
    if (last && Math.abs(last.value - p.v) <= 0.5) { last.to = p.w; continue; }
    steps.push({ from: p.w, to: p.w, value: p.v });
  }
  const distinct = new Set(steps.map((s) => round(s.value, 2)));
  if (distinct.size === 1) return { kind: 'constant', css: `${fmt(pts[0].v, 3)}px`, media: [], evidence, notes, residual: 0 };
  const media = steps.slice(1).map((s) => ({ minWidth: s.from, value: `${fmt(s.value, 3)}px`, range: [s.from, s.to] }));
  notes.push(`non-linear: ${steps.length} ranges — emitted as media queries`);
  return { kind: 'steps', css: `${fmt(steps[0].value, 3)}px`, media, evidence, notes, residual: round(Math.max(...steps.map((s) => Math.abs(s.value - steps[0].value))), 2), steps };
}

/** CSS custom property (plus media queries when stepped). */
export function cssVar(name, sol, { indent = '  ', comment = true, media = true } = {}) {
  if (!sol?.css) return '';
  const pad = ' '.repeat(indent.length);
  const head = comment ? `${indent}/* ${sol.kind}${sol.residual ? ` ±${sol.residual}px` : ''} · ${sol.evidence} */\n` : '';
  const body = `${indent}--${name}: ${sol.css};`;
  const mediaCss = !media ? '' : (sol.media ?? []).map((m) => `\n@media (min-width: ${m.minWidth}px) {\n${indent}:root { --${name}: ${m.value}; }\n}`).join('');
  return `${head}${body}${mediaCss}`;
}

/** Coherence linter — the "fidelity vs coherence" rule as code. */
export function lintTokens(tokens = {}, { gridUnit = 4, minContrast = 4.5 } = {}) {
  const issues = [];
  for (const s of tokens.space?.steps ?? []) {
    if (s % gridUnit !== 0) issues.push({ level: 'warn', target: 'space', msg: `${s}px is off the ${gridUnit}px grid` });
  }
  const sizes = (tokens.fonts ?? []).map((f) => parsePx(f.size)).filter(Boolean).sort((a, b) => a - b);
  for (let i = 1; i < sizes.length; i++) {
    const ratio = sizes[i] / sizes[i - 1];
    if (ratio > 1.8) issues.push({ level: 'info', target: 'type-scale', msg: `${sizes[i - 1]}px → ${sizes[i]}px (×${round(ratio, 2)}) is a big jump` });
    if (ratio < 1.05 && sizes[i] !== sizes[i - 1]) issues.push({ level: 'warn', target: 'type-scale', msg: `${sizes[i - 1]}px and ${sizes[i]}px are nearly identical` });
  }
  const byName = Object.fromEntries((tokens.colors ?? []).map((c) => [c.name, c.hex]));
  const uniq = (names) => {
    const seen = new Set();
    return names.filter((k) => {
      if (!byName[k] || seen.has(byName[k])) return false;
      seen.add(byName[k]);
      return true;
    });
  };
  const surfaces = uniq(['surface', 'surface-alt', 'surfaceAlt']);
  const inks = uniq(['ink', 'muted', 'accent']);
  // every foreground must be readable on EVERY surface it can sit on (this is the
  // rule that a one-surface check silently misses — a real run failed on it)
  for (const fg of inks) {
    for (const bg of surfaces) {
      const r = contrast(byName[fg], byName[bg]);
      if (Number.isNaN(r)) continue;
      const lvl = wcagLevel(r);
      if (lvl === 'fail') issues.push({ level: 'error', target: 'contrast', msg: `${fg} on ${bg} = ${r}:1 (${lvl})` });
      else if (lvl !== 'AAA') issues.push({ level: 'info', target: 'contrast', msg: `${fg} on ${bg} = ${r}:1 (${lvl})` });
    }
  }
  for (const [fg, bg] of [['inverse', 'accent'], ['accentInk', 'accent']]) {
    if (!byName[fg] || !byName[bg]) continue;
    const r = contrast(byName[fg], byName[bg]);
    if (!Number.isNaN(r) && wcagLevel(r) === 'fail') issues.push({ level: 'error', target: 'contrast', msg: `${fg} on ${bg} = ${r}:1 (fail)` });
  }
  for (const r of tokens.radius ?? []) {
    if (r.px > 0 && r.px < 2) issues.push({ level: 'info', target: 'radius', msg: `${r.name}=${r.px}px is a hairline radius` });
  }
  return issues;
}

export const SCALE_HEADER = '/* generated by fidelity/spec.mjs — scale solver output; each value cites the measurements it came from */';
