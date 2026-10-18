// Syntax gate: every script in the skill must parse. `node --check` is cheap and
// catches the class of error a live run would only surface after a 40s scrape.
// Usage: node syntax.mjs [--verbose]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes('--verbose');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.mjs') || e.name.endsWith('.js') || e.name.endsWith('.cjs')) out.push(p);
  }
  return out;
}

const files = walk(here).filter((f) => path.resolve(f) !== path.resolve(fileURLToPath(import.meta.url)));
const failed = [];
for (const f of files) {
  const run = spawnSync('node', ['--check', f], { encoding: 'utf8' });
  if (run.status !== 0) failed.push({ file: path.relative(here, f), error: (run.stderr || '').split('\n').slice(0, 3).join(' ') });
  else if (verbose) console.log(`ok  ${path.relative(here, f)}`);
}
console.log(JSON.stringify({ ok: failed.length === 0, checked: files.length, failed }));
if (failed.length) process.exit(1);
