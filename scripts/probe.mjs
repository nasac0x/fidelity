#!/usr/bin/env node
// PROBE — run an ad-hoc measurement script with the right Playwright context, a hard
// timeout and a guaranteed cleanup. Exists because the failing pattern is real:
// a probe parked a forever-promise inside page.evaluate and hung the shell twice.
//
//   node probe.mjs --file probes/carousel.mjs --url http://localhost:3000 [--width 1366]
//   node probe.mjs --eval-file probes/dump-dom.js --url ...      # runs the file INSIDE the page
//
// probes/carousel.mjs:
//   export default async ({ page, url, width, log, save }) => {
//     const t = await page.evaluate(() => document.querySelector('.slide')?.style.transform);
//     log('transform', t);
//     return { ok: true, t };                 // printed as `probe {...}`
//   };
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, num, str, flag, loadConfig, readText, rel, usage, summary } from './lib/core.mjs';
import { withBrowser, newPage, prepare } from './lib/browser.mjs';

const A = parseArgs();
const url = str(A.url);
if (!url) usage('probe.mjs --file probe.mjs --url http://localhost:3000 [--width 1366] [--timeout 20000]');
const cfg = loadConfig(A);
const width = num(A.width, 1366);
const budget = num(A.timeout, 20000);

const timeout = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error(`probe timed out after ${ms}ms (${label})`)), ms).unref?.());

await withBrowser(async (browser) => {
  const made = await newPage(browser, { ...cfg, width });
  const page = made.page;
  await prepare(page, { url, timeoutMs: cfg.timeoutMs, settleMs: num(A.settle, cfg.settleMs), scrollThrough: cfg.scrollThrough !== false, dismiss: A.dismiss });

  if (A.evalFile) {
    const code = readText(path.resolve(String(A.evalFile)));
    // `--eval-file` is an EXPRESSION (what page.evaluate takes). A lone arrow
    // function is the classic mistake: it "returns" a function, so the result is
    // undefined. Detect that and call it instead of failing silently.
    let result = await Promise.race([page.evaluate(code), timeout(budget, 'eval-file')]);
    if (result === undefined && /^\s*\(?\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*=>/.test(code)) {
      console.log('  · --eval-file looked like a function; calling it');
      result = await Promise.race([page.evaluate(`(${code})()`), timeout(budget, 'eval-file (called)')]);
    }
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 1));
  } else if (A.file) {
    const file = pathToFileURL(path.resolve(String(A.file))).href;
    const mod = await import(file);
    const fn = mod.default;
    if (typeof fn !== 'function') usage(`${A.file} must export default async ({ page, log }) => {...}`);
    const logs = [];
    const result = await Promise.race([
      fn({
        page, url, width,
        log: (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); console.log('  ·', ...a); },
        save: (name, data) => {
          const p = path.resolve('probe-out', name);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
          console.log(`  ↓ ${p}`);
          return p;
        },
      }),
      timeout(budget, 'probe file'),
    ]);
    summary('probe', { file: rel(path.resolve(String(A.file)), process.cwd()), width, logs: logs.length, result: result === undefined ? null : result });
  } else usage('probe.mjs --file probe.mjs | --eval-file code.js --url <URL>');
  await made.context.close().catch(() => { });
});
