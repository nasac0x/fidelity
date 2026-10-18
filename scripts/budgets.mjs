#!/usr/bin/env node
// BUDGETS — the non-visual quality gate: accessibility (axe-core), contrast on the
// spec tokens (WCAG), and a local performance budget (LCP/CLS/bytes/requests).
//
//   node budgets.mjs --url http://localhost:3000 --out budgets [--spec spec/spec.json]
//                    [--axe-impact serious] [--max-lcp 2500] [--max-cls 0.1] [--max-kb 900]
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  parseArgs, num, str, flag, csv, readJsonSafe, writeJson, writeText, ensureDir, rmrf, rel,
  usage, summary, stamp, round, contrast, wcagLevel, humanBytes,
} from './lib/core.mjs';
import { withBrowser, newPage, prepare } from './lib/browser.mjs';

const A = parseArgs();
const url = str(A.url);
if (!url) usage('Usage: node budgets.mjs --url http://localhost:3000 --out budgets [--spec spec/spec.json]');
const outDir = path.resolve(str(A.out, 'budgets'));
rmrf(outDir); ensureDir(outDir);
const widths = csv(str(A.widths)).length ? csv(str(A.widths)) : [1366];
const spec = A.spec ? readJsonSafe(path.resolve(String(A.spec))) : undefined;
const budgets = {
  maxLcp: num(A.maxLcp, 2500), maxCls: num(A.maxCls, 0.1), maxKb: num(A.maxKb, 900), maxRequests: num(A.maxRequests, 70),
};
const axeImpact = str(A.axeImpact, 'serious');
const IMPACT_ORDER = ['minor', 'moderate', 'serious', 'critical'];
const minImpact = IMPACT_ORDER.indexOf(axeImpact);

let axePath;
try { axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js'); } catch { }

const a11y = [];
const perf = [];
const pages = [];

await withBrowser(async (browser) => {
  for (const width of widths) {
    const made = await newPage(browser, { width, height: 900 });
    const page = made.page;
    await page.addInitScript(() => {
      window.__perf = { lcp: 0, cls: 0, longTasks: 0 };
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = Math.round(e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls = +(window.__perf.cls + e.value).toFixed(4); }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((l) => { window.__perf.longTasks += l.getEntries().length; }).observe({ type: 'longtask', buffered: true });
      } catch { }
    });
    try {
      await prepare(page, { url, timeoutMs: 30000, settleMs: 800, scrollThrough: true });
      await page.waitForTimeout(600);

      // --- performance ---
      const metrics = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] ?? {};
        const res = performance.getEntriesByType('resource');
        const byType = {};
        let bytes = 0;
        for (const r of res) {
          const b = r.transferSize || r.encodedBodySize || 0;
          bytes += b;
          const t = r.initiatorType || 'other';
          byType[t] = byType[t] ?? { n: 0, bytes: 0 };
          byType[t].n++; byType[t].bytes += b;
        }
        const biggest = res.map((r) => ({ url: r.name, bytes: r.transferSize || r.encodedBodySize || 0 }))
          .sort((a, b) => b.bytes - a.bytes).slice(0, 5);
        return {
          ttfb: Math.round(nav.responseStart ?? 0), dcl: Math.round(nav.domContentLoadedEventEnd ?? 0),
          load: Math.round(nav.loadEventEnd ?? 0), requests: res.length, bytes, byType, biggest,
          ...(window.__perf ?? {}),
        };
      });
      const problems = [];
      if (metrics.lcp > budgets.maxLcp) problems.push(`LCP ${metrics.lcp}ms > ${budgets.maxLcp}ms`);
      if (metrics.cls > budgets.maxCls) problems.push(`CLS ${metrics.cls} > ${budgets.maxCls}`);
      if (metrics.bytes / 1024 > budgets.maxKb) problems.push(`${humanBytes(metrics.bytes)} > ${budgets.maxKb}KB`);
      if (metrics.requests > budgets.maxRequests) problems.push(`${metrics.requests} requests > ${budgets.maxRequests}`);
      perf.push({ width, ...metrics, budgets, ok: problems.length === 0, problems });

      // --- accessibility (axe) ---
      if (axePath) {
        await page.addScriptTag({ path: axePath });
        const res = await page.evaluate(async (minImpact) => {
          const order = ['minor', 'moderate', 'serious', 'critical'];
          const out = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
          return {
            violations: out.violations.map((v) => ({
              id: v.id, impact: v.impact, help: v.help, tags: v.tags.filter((t) => t.startsWith('wcag')).slice(0, 3),
              nodes: v.nodes.length,
              examples: v.nodes.slice(0, 2).map((n) => ({ target: Array.isArray(n.target) ? n.target.join(' ') : String(n.target), summary: String(n.failureSummary ?? '').slice(0, 160) })),
              overBudget: order.indexOf(v.impact) >= minImpact,
            })),
            passes: out.passes.length,
          };
        }, minImpact);
        const over = res.violations.filter((v) => v.overBudget);
        a11y.push({ width, violations: res.violations.length, overBudget: over.map((v) => v.id), ok: over.length === 0, detail: res.violations });
      }

      pages.push({ width, ok: true });
    } catch (err) {
      pages.push({ width, ok: false, error: String(err).slice(0, 200) });
    } finally {
      await made.context.close().catch(() => { });
    }
  }
});

// --- token contrast (WCAG) from the spec, no browser needed ---
const contrastChecks = [];
const byName = spec?.tokens?.colors ? Object.fromEntries(spec.tokens.colors.map((c) => [c.name, c.hex]))
  : spec?.design?.colors ? { ...spec.design.colors } : null;
if (byName) {
  for (const [fg, bg, large] of [['ink', 'surface', false], ['ink', 'surface-alt', false], ['inverse', 'accent', false], ['accent', 'surface', false]]) {
    if (!byName[fg] || !byName[bg]) continue;
    const ratio = contrast(byName[fg], byName[bg]);
    const level = wcagLevel(ratio, large);
    contrastChecks.push({ fg, bg, ratio, level, ok: level === 'AAA', warn: level === 'fail' });
  }
}

const a11yFailed = a11y.filter((a) => !a.ok);
const perfFailed = perf.filter((p) => !p.ok);
const contrastFailed = contrastChecks.filter((c) => c.warn);
const ok = !a11yFailed.length && !perfFailed.length && !contrastFailed.length && pages.every((p) => p.ok);

const md = [];
md.push(`# Budgets — ${stamp()}`, '', `**${ok ? 'PASS' : 'FAIL'}** · axe impact ≥ ${axeImpact} · LCP ≤ ${budgets.maxLcp}ms · CLS ≤ ${budgets.maxCls} · ≤ ${budgets.maxKb}KB · ≤ ${budgets.maxRequests} requests`, '');
md.push('## Accessibility (axe-core)', '');
if (!axePath) md.push('_axe-core not installed — run `npm install` inside the skill scripts dir._');
for (const a of a11y) {
  md.push(`### ${a.width}px — ${a.violations} violation(s), ${a.ok ? 'none over budget ✅' : `${a.overBudget.length} over budget ❌`}`, '');
  for (const v of a.detail ?? []) md.push(`- ${v.overBudget ? '❌' : '⚠️'} **${v.id}** (${v.impact}, ${v.nodes} node(s)) — ${v.help}${v.examples?.length ? `\n  - e.g. \`${v.examples[0].target}\` ${v.examples[0].summary}` : ''}`);
  md.push('');
}
md.push('## Performance (local, no throttling)', '', '| width | LCP | CLS | requests | bytes | load | by type |', '|---|---|---|---|---|---|---|');
for (const p of perf) md.push(`| ${p.width} | ${p.lcp ?? '?'}ms | ${p.cls ?? '?'} | ${p.requests} | ${humanBytes(p.bytes)} | ${p.load}ms | ${Object.entries(p.byType).map(([k, v]) => `${k} ${humanBytes(v.bytes)}`).join(', ')} |`);
md.push('');
for (const p of perfFailed) md.push(`❌ ${p.width}px: ${p.problems.join('; ')}`);
md.push('', '### Biggest resources', '');
for (const p of perf.slice(0, 1)) for (const b of p.biggest ?? []) md.push(`- ${humanBytes(b.bytes)} — ${b.url.slice(0, 120)}`);
md.push('', '## Contrast on spec tokens', '', '| pair | ratio | level |', '|---|---|---|');
for (const c of contrastChecks) md.push(`| ${c.fg} on ${c.bg} | ${c.ratio}:1 | ${c.level}${c.ok ? ' ✅' : c.warn ? ' ❌' : ' ⚠️'} |`);
writeText(path.join(outDir, 'report.md'), md.join('\n') + '\n');
writeJson(path.join(outDir, 'report.json'), { at: stamp(), url, axeImpact, budgets, ok, a11y, perf, contrast: contrastChecks, pages });
writeJson(path.join(outDir, 'gate.json'), { ok, a11y: a11yFailed.length, perf: perfFailed.length, contrast: contrastFailed.length, at: stamp() });

summary('budgets', { ok, a11yOverBudget: a11yFailed.flatMap((a) => a.overBudget), perfProblems: perfFailed.flatMap((p) => p.problems), contrastFail: contrastFailed.map((c) => `${c.fg}/${c.bg}`), out: rel(outDir, process.cwd()) });
process.exit(ok ? 0 : 1);
