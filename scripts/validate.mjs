#!/usr/bin/env node
// VALIDATE — run validation.json against the build at every width, in passes.
// stdout is deliberately tiny (failures + summary); the full table goes to
// report/report.md and report/report.json. `--json` prints only machine output.
//
//   node validate.mjs --checks validation.json --out report [--url ...] [--widths 390,1366] [--retries 2]
//   node validate.mjs --checks validation.json --all        # print every check, not just failures
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, num, str, flag, csv, readJsonSafe, writeJson, writeText, ensureDir, rmrf,
  rel, usage, summary, stamp, banner,
} from './lib/core.mjs';
import { withBrowser, newPage, prepare } from './lib/browser.mjs';
import { runCheck } from './lib/checks.mjs';

const A = parseArgs();
const checksPath = str(A.checks, 'validation.json');
const config = readJsonSafe(path.resolve(checksPath));
if (!config) usage(`Usage: node validate.mjs --checks validation.json --out report/ [--url http://localhost:3000]`);
const outDir = path.resolve(str(A.out, 'report'));
rmrf(outDir);
ensureDir(outDir);
if (A.log) { ensureDir(path.dirname(path.resolve(String(A.log)))); }

const widths = csv(str(A.widths)).length ? csv(str(A.widths)) : (config.widths ?? [1366]);
const height = num(A.height, config.height ?? 900);
const retries = num(A.retries, config.retries ?? 0);
const passes = config.passes?.length ? config.passes : [{ name: 'default' }];
const pageDefs = config.pages?.length
  ? config.pages.map((p, i) => ({ name: p.name ?? `page-${i + 1}`, url: str(A.url, p.url), checks: p.checks ?? [], widths: p.widths }))
  : [{ name: 'main', url: str(A.url, config.url), checks: config.checks ?? [] }];
const shots = Array.isArray(config.elementShots)
  ? config.elementShots
  : Object.entries(config.elementShots ?? {}).map(([key, selector]) => ({ key, selector }));

const results = [];
const screenshots = [];
const startedAt = stamp();

await withBrowser(async (browser) => {
  for (const pageDef of pageDefs) {
    for (const pass of passes) {
      for (const width of (pageDef.widths ?? widths)) {
        let context;
        const requests = [];
        let bytes = 0;
        try {
          const made = await newPage(browser, { ...config, width, height, reducedMotion: !!pass.reducedMotion });
          const page = made.page;
          context = made.context;
          page.on('request', (r) => requests.push(r.url()));
          page.on('response', async (r) => {
            try { const l = r.headers()['content-length']; if (l) bytes += Number(l); } catch { }
          });
          const ctxBase = { requests, bytes, pass: pass.name, width };
          await prepare(page, {
            url: pageDef.url, timeoutMs: config.timeoutMs ?? 30000,
            settleMs: num(A.settle, config.settleMs ?? 500),
            scrollThrough: config.scrollThrough !== false,
            dismiss: config.dismiss ?? [], waitFor: config.waitFor ?? null,
          });
          await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve())).catch(() => { });
          if (config.screenshot !== false) {
            const shot = path.join(outDir, `screenshot-${pass.name === 'default' ? '' : `${pass.name}-`}${width}.png`);
            await page.screenshot({ path: shot, fullPage: true });
            screenshots.push(rel(shot, process.cwd()));
          }
          for (const { key, selector } of shots) {
            const p = path.join(outDir, `element-${pass.name === 'default' ? '' : `${pass.name}-`}${width}-${key}.png`);
            await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { });
            await page.locator(selector).first().screenshot({ path: p, timeout: 8000 }).catch((err) => console.error(`element shot ${key}@${width}: ${String(err).slice(0, 90)}`));
          }
          const mine = pageDef.checks.filter((c) => (!c.width || c.width === width)
            && (!pass.only || pass.only.includes(c.type)) && (!pass.except || !pass.except.includes(c.type)));
          for (const check of mine) {
            const r = await runCheck(page, check, ctxBase);
            results.push({ ...r, page: pageDef.name, passName: pass.name, width });
          }
          // retries for flaky captures (fonts/images still settling)
          for (let attempt = 1; attempt <= retries; attempt++) {
            const failedIdx = results.map((r, i) => ({ r, i })).filter(({ r }) => !r.pass && !r.soft && r.page === pageDef.name && r.passName === pass.name && r.width === width);
            if (!failedIdx.length) break;
            await page.reload({ waitUntil: 'load', timeout: config.timeoutMs ?? 30000 }).catch(() => { });
            await prepare(page, { url: pageDef.url, settleMs: config.settleMs ?? 500, scrollThrough: config.scrollThrough !== false });
            await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve())).catch(() => { });
            for (const { r, i } of failedIdx) {
              const check = mine.find((c) => c.from === r.from && c.type === r.type && String(c.selector) === String(r.selector));
              if (!check) continue;
              const again = await runCheck(page, check, ctxBase);
              if (again.pass) results[i] = { ...again, page: pageDef.name, passName: pass.name, width, retried: attempt };
            }
          }
        } catch (err) {
          const mine = pageDef.checks.filter((c) => !c.width || c.width === width);
          for (const check of mine) results.push({ ...check, type: check.type, width, passName: pass.name, page: pageDef.name, pass: false, soft: !!check.soft, actual: `page error: ${String(err).slice(0, 160)}` });
          if (!mine.length) results.push({ type: 'page', page: pageDef.name, passName: pass.name, width, pass: false, actual: `page error: ${String(err).slice(0, 160)}` });
        } finally {
          await context?.close().catch(() => { });
        }
      }
    }
  }
});

const hard = results.filter((r) => !r.soft);
const failed = hard.filter((r) => !r.pass);
const softFailed = results.filter((r) => r.soft && !r.pass);

const fmtExpected = (r) => {
  if (r.approxPx !== undefined) return `${r.prop ?? 'box'} ≈ ${r.approxPx}±${r.tolerancePx ?? 2}px`;
  if (r.minPx !== undefined || r.maxPx !== undefined) return `${r.prop} in ${r.minPx ?? '-∞'}..${r.maxPx ?? '∞'}`;
  if (r.equals !== undefined) return JSON.stringify(r.equals).slice(0, 60);
  if (r.rules) return `a11y ${r.rules.join(',')}`;
  if (r.steps) return 'probe';
  if (r.type === 'hover') return 'state change on hover';
  if (r.type === 'focus') return 'visible focus style';
  if (r.type === 'scroll') return 'position after scroll';
  return '—';
};

let md = `# Validation report — ${startedAt}\n\nURL: \`${pageDefs.map((p) => p.url).join('`, `')}\`\n\n`;
md += `**${hard.length - failed.length}/${hard.length} checks passed, ${failed.length} failed${softFailed.length ? ` (${softFailed.length} soft warnings)` : ''}.** `;
md += `${failed.length === 0 ? 'ALL PASS.' : 'Fix the failures below; do not change content.'}\n\n`;
if (failed.length) {
  md += `## Failures\n\n| page | pass | width | type | selector | expected | actual |\n|---|---|---|---|---|---|---|\n`;
  for (const r of failed) md += `| ${r.page} | ${r.passName ?? 'default'} | ${r.width} | ${r.type} | \`${r.selector ?? r.js ?? r.from ?? r.rules ?? 'page'}\` | ${fmtExpected(r)} | ${String(r.actual).slice(0, 70)} |\n`;
  md += '\n';
}
if (screenshots.length) md += `## Screenshots\n\n` + screenshots.map((s) => `- ![](${rel(path.resolve(s), outDir)})`).join('\n') + '\n\n';
md += `## All results\n\n| page | pass | width | type | selector | expected | actual | result |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of results) md += `| ${r.page} | ${r.passName ?? 'default'} | ${r.width} | ${r.type} | \`${r.selector ?? r.js ?? r.from ?? 'page'}\` | ${fmtExpected(r)} | ${String(r.actual).slice(0, 70)} | ${r.pass ? '✅' : r.soft ? '⚠️' : '❌'} |\n`;
writeText(path.join(outDir, 'report.md'), md);
writeJson(path.join(outDir, 'report.json'), {
  startedAt, url: pageDefs.map((p) => p.url), checksPath: rel(path.resolve(checksPath), process.cwd()),
  totals: { checks: results.length, hard: hard.length, passed: hard.length - failed.length, failed: failed.length, softFailed: softFailed.length },
  passes: passes.map((p) => p.name), widths,
  failures: failed.map((r) => ({ ...r, pass: undefined })),
  results,
});
// machine-readable single line for orchestrators (gate.mjs)
writeJson(path.join(outDir, 'gate.json'), { ok: failed.length === 0, failed: failed.length, total: hard.length, softFailed: softFailed.length, report: rel(path.join(outDir, 'report.json'), process.cwd()), at: stamp() });

if (flag(A.json)) {
  summary('validate', { ok: failed.length === 0, failed: failed.length, total: hard.length, out: rel(outDir, process.cwd()) });
} else {
  console.log(`validate: ${hard.length - failed.length}/${hard.length} passed, ${failed.length} failed${softFailed.length ? `, ${softFailed.length} soft` : ''}`);
  const show = flag(A.all) ? results : failed;
  const limit = num(A.max, 40);
  for (const r of show.slice(0, limit)) {
    const mark = r.pass ? '✓' : r.soft ? '⚠' : '✗';
    console.log(`  ${mark} [${String(r.width).padStart(4)}${r.passName && r.passName !== 'default' ? `/${r.passName}` : ''}] ${r.type.padEnd(12)} ${String(r.selector ?? r.js ?? r.from ?? 'page').slice(0, 42).padEnd(42)} ${r.pass ? '' : `want ${fmtExpected(r)} · got ${String(r.actual).slice(0, 50)}${r.detail ? ` (${String(r.detail).slice(0, 100)})` : ''}`}`);
  }
  if (show.length > limit) console.log(`  … ${show.length - limit} more (use --all or read ${rel(path.join(outDir, 'report.json'), process.cwd())})`);
  console.log(`report → ${rel(path.join(outDir, 'report.md'), process.cwd())}`);
}
process.exit(failed.length ? 1 : 0);
