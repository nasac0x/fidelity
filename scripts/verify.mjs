#!/usr/bin/env node
// VERIFY — integrity + the final mechanical gate.
//
//   node verify.mjs sources --manifest spec/sources/manifest.json [--dir .]
//   node verify.mjs gate    [--dir .] [--require validate,visual,budgets]
//
// `gate` merges every gate.json produced by validate / visual-diff / budgets /
// classify / judge into ONE verdict. A generated site is only "done" when this passes.
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs, str, arr, csv, flag, readJsonSafe, writeJson, exists, humanBytes, rel, usage, summary, stamp, sha256 } from './lib/core.mjs';

const A = parseArgs();
const cmd = String(A._[0] ?? 'gate');
const dir = path.resolve(str(A.dir, '.'));

function sources() {
  const manifestPath = path.resolve(str(A.manifest, path.join(dir, 'spec/sources/manifest.json')));
  const manifest = readJsonSafe(manifestPath);
  if (!manifest) usage('verify.mjs sources --manifest spec/sources/manifest.json [--dir .]');
  const issues = [];
  for (const f of manifest.files ?? []) {
    if (!f.path || f.skipped) continue;
    const p = path.resolve(dir, f.path);
    if (!exists(p)) { issues.push({ kind: 'missing', path: f.path }); continue; }
    const buf = fs.readFileSync(p);
    const h = sha256(buf);
    if (f.sha256 && h !== f.sha256) issues.push({ kind: 'modified', path: f.path, expected: f.sha256.slice(0, 12), actual: h.slice(0, 12) });
    if (f.bytes && buf.length !== f.bytes) issues.push({ kind: 'size-changed', path: f.path, expected: f.bytes, actual: buf.length });
  }
  const report = { manifest: rel(manifestPath, dir), checkedAt: stamp(), files: (manifest.files ?? []).length, issues };
  writeJson(path.join(dir, 'spec/sources/verify.json'), report);
  summary('verify-sources', { files: report.files, issues: issues.length, ok: issues.length === 0 });
  for (const i of issues) console.log(`  ✗ ${i.kind}: ${i.path}${i.expected ? ` (expected ${i.expected}, got ${i.actual})` : ''}`);
  if (!issues.length) console.log('  ✓ every pinned source matches its recorded hash');
  process.exit(issues.length ? 1 : 0);
}

function gate() {
  const required = csv(str(A.require, 'validate,visual'), String).filter(Boolean);
  const candidates = {
    validate: str(A.validate, 'report/gate.json'),
    visual: str(A.visual, 'visual-report/gate.json'),
    budgets: str(A.budgets, 'budgets/gate.json'),
    classify: str(A.classify, 'visual-report/classify.json'),
    judge: str(A.judge, 'judge/gate.json'),
    sources: str(A.sources, 'spec/sources/verify.json'),
    spec: str(A.spec, 'spec/check.json'),
    drift: str(A.drift, 'spec/drift.json'),
  };
  const found = {};
  for (const [name, p] of Object.entries(candidates)) {
    const abs = path.resolve(dir, String(p));
    if (exists(abs)) found[name] = { path: rel(abs, dir), ...readJsonSafe(abs) };
  }
  const problems = [];
  for (const need of required) {
    if (!found[need]) problems.push(`${need}: no gate report found (run it first)`);
    else if (found[need].ok === false) problems.push(`${need}: FAILED (${found[need].failed ?? found[need].issues?.length ?? 'details in report'})`);
  }
  if (found.spec && (found.spec.errors ?? []).length) problems.push(`spec: ${found.spec.errors.length} error(s)`);
  if (found.sources && (found.sources.issues ?? []).length) problems.push(`sources: ${found.sources.issues.length} drifted/missing file(s)`);
  if (found.drift && (found.drift.issues ?? []).some((i) => i.kind === 'html-changed')) problems.push('reference changed since the SPEC was captured (re-capture and re-check the spec)');
  if (found.judge?.verdict === 'fail') problems.push(`independent judge: ${found.judge.failed} region(s) it considers unfaithful`);
  if (found.classify?.byCause) {
    const unknown = Object.keys(found.classify.byCause).filter((c) => c === 'unknown');
    if (unknown.length) problems.push('some visual failures are still unclassified (open the contact sheet)');
  }
  const report = {
    at: stamp(), dir: rel(dir, process.cwd()), ok: problems.length === 0,
    reports: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, { path: v.path, ok: v.ok, failed: v.failed, issues: v.issues?.length }])),
    problems,
  };
  writeJson(path.join(dir, 'gate-report.json'), report);
  summary('verify-gate', { ok: report.ok, reports: Object.keys(found), problems: problems.length });
  for (const p of problems) console.log(`  ✗ ${p}`);
  if (report.ok) console.log('  ✓ mechanical gate passed — now read the contact sheet once and report honestly to the user');
  process.exit(report.ok ? 0 : 1);
}

switch (cmd) {
  case 'sources': sources(); break;
  case 'gate': gate(); break;
  default: usage('verify.mjs <sources|gate> [--manifest path] [--dir .] [--require validate,visual,budgets]');
}
