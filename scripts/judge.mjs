#!/usr/bin/env node
// JUDGE — the independent (second-opinion) visual judge.
// Our diff is numeric; a mismatched font or a subtly wrong crop can still pass it.
// So the judge bundle ships ONE contact sheet + the measured facts + the spec
// excerpt, and asks a different model (or a subagent) a strict yes/no per region.
//
//   node judge.mjs bundle --visual visual-report/report.json --spec spec/spec.json --out judge
//   node judge.mjs call   --bundle judge/bundle.json          # needs FIDELITY_JUDGE_* env
//   node judge.mjs verify --file judge/verdict.json           # schema + disagreement check
//
// No API key configured? The bundle is still the right input for a subagent:
// hand it judge/prompt.md + judge/sheet.png and paste back the JSON verdict.
import path from 'node:path';
import fs from 'node:fs';
import {
  parseArgs, num, str, flag, readJsonSafe, writeJson, writeText, ensureDir, loadConfig,
  rel, usage, summary, stamp, round,
} from './lib/core.mjs';
import { contactSheet, loadImage } from './lib/img.mjs';

const A = parseArgs();
const cmd = String(A._[0] ?? 'bundle');
const cfg = loadConfig(A);

const SCHEMA = {
  verdict: 'pass | fail',
  regions: [{
    name: 'string — the region name ONLY (e.g. "hero"), without @width',
    width: 'number — the number from hero@390',
    faithful: 'boolean — would a designer accept this as the same design?',
    differences: [{ what: 'string — the visible difference', severity: 'low|medium|high', evidence: 'string — where in the image' }],
    confidence: '0..1',
    userWouldNotice: 'boolean',
  }],
  overallNotes: 'string — 1–3 sentences',
};

async function bundle() {
  const visualPath = path.resolve(str(A.visual, 'visual-report/report.json'));
  const visual = readJsonSafe(visualPath);
  if (!visual) usage('judge.mjs bundle --visual visual-report/report.json [--spec spec/spec.json] [--out judge]');
  const spec = A.spec ? readJsonSafe(path.resolve(String(A.spec))) : undefined;
  const outDir = path.resolve(str(A.out, 'judge'));
  ensureDir(outDir);
  const pairsCfg = A.pairs ? readJsonSafe(path.resolve(String(A.pairs))) : undefined;
  const pairMap = new Map((pairsCfg?.pairs ?? []).map((p) => [`${p.name}@${p.width}`, p]));
  const failing = (visual.results ?? []).filter((r) => !r.pass);
  // A numeric diff can pass a wrong font or a subtly wrong crop, so a couple of
  // PASSING regions (the ones closest to the threshold) are audited too.
  const audit = (visual.results ?? []).filter((r) => r.pass).sort((a, b) => (b.diffPct ?? 0) - (a.diffPct ?? 0)).slice(0, num(A.audit, 2));
  const review = [...failing.map((r) => ({ ...r, audit: false })), ...audit.map((r) => ({ ...r, audit: true }))];
  const imageOf = (r) => {
    const pair = pairMap.get(`${r.name}@${r.width}`);
    return { ref: pair?.ref ?? r.ref, build: pair?.build ?? r.build };
  };
  const regions = review.map((r) => {
    const block = spec?.blocks?.find((b) => (b.name ?? '') === r.name);
    const pair = imageOf(r);
    return {
      name: r.name, width: r.width, audit: r.audit,
      measured: { diffPct: r.diffPct, clusters: r.clusters?.slice(0, 4), shift: r.shift },
      images: { ref: pair.ref, build: pair.build, diff: r.diffImage },
      masks: (pairsCfg?.masks?.[`${r.name}@${r.width}`] ?? []).map((m) => `${m.reason ?? 'substituted'} [${m.x},${m.y} ${m.w}×${m.h}]`),
      spec: block ? { selector: block.selector, copy: (spec.copy ?? []).filter((c) => c.block === block.name).map((c) => `${c.selector}: ${JSON.stringify(c.text)} (${c.chars} chars)`), measuredBox: block.measure?.[spec.designWidth]?.box } : undefined,
    };
  });
  let sheetPath;
  const tiles = [];
  for (const r of review) {
    const { ref, build } = imageOf(r);
    if (!ref || !build || !fs.existsSync(path.resolve(ref)) || !fs.existsSync(path.resolve(build))) continue;
    tiles.push({ label: `${r.name}@${r.width} — measured diff ${r.diffPct}%${r.audit ? ' (audit)' : ''}`, images: [{ name: 'reference', src: path.resolve(ref) }, { name: 'build', src: path.resolve(build) }] });
  }
  if (tiles.length) { sheetPath = path.join(outDir, 'sheet.png'); await contactSheet({ tiles, out: sheetPath, cols: 1, tileWidth: num(A.tileWidth, 760) }); }

  const prompt = [
    `# Independent fidelity review`, '',
    `You are reviewing a pixel-fidelity clone. You will see ONE contact sheet: for every region, the`,
    `reference on top and the build below, at the same viewport width. Measurements from an automated`,
    `diff are provided, but you are the tie-breaker: answer whether a designer would accept the build as`,
    `the SAME design as the reference.`, '',
    `Rules:`,
    `- Judge only what is visible in the sheet. Do not infer from the measurements; they can be fooled.`,
    `- Substituted brand art (de-branded clones) is expected and marked in the bundle — do not report it.`,
    `- Report the single most important difference per region, with where it is (e.g. "headline baseline, left edge").`,
    `- Be strict about: font substitution, letter/word spacing, text wrapping, vertical rhythm, colour, image crop.`,
    `- In the answer, "name" is the region name only ("hero", not "hero@390"); "width" carries the number.`,
    `- Answer with JSON only, matching this schema exactly:`, '',
    '```json', JSON.stringify(SCHEMA, null, 2), '```', '',
    `Regions under review:`, ...regions.map((r) => `- ${r.name}@${r.width} (measured diff ${r.measured.diffPct}%, ${r.measured.clusters?.length ?? 0} cluster(s))`), '',
  ].join('\n');
  writeText(path.join(outDir, 'prompt.md'), prompt);
  writeJson(path.join(outDir, 'bundle.json'), { at: stamp(), visual: rel(visualPath, process.cwd()), sheet: sheetPath ? rel(sheetPath, process.cwd()) : undefined, regions, schema: SCHEMA });
  summary('judge-bundle', { regions: regions.length, sheet: sheetPath ? rel(sheetPath, process.cwd()) : 'none (no readable image pairs)', prompt: rel(path.join(outDir, 'prompt.md'), process.cwd()) });
  if (!sheetPath) console.log('  ! no ref/build image pairs resolved — pass the pairs.json path so images can be located');
  console.log(`  next: read ${rel(path.join(outDir, 'sheet.png'), process.cwd())} + ${rel(path.join(outDir, 'prompt.md'), process.cwd())} (or run: node judge.mjs call)`);
}

async function call() {
  const bundlePath = path.resolve(str(A.bundle, 'judge/bundle.json'));
  const b = readJsonSafe(bundlePath);
  if (!b) usage('judge.mjs call --bundle judge/bundle.json');
  if (!cfg.judge?.url || !cfg.judge?.key) {
    summary('judge-call', { ok: false, reason: 'no judge endpoint configured — set FIDELITY_JUDGE_URL / FIDELITY_JUDGE_KEY / FIDELITY_JUDGE_MODEL' });
    console.log('  fallback (no key needed): spawn a subagent with judge/prompt.md + judge/sheet.png and paste back the JSON verdict as judge/verdict.json');
    process.exit(0);
  }
  const sheetAbs = b.sheet ? path.resolve(b.sheet) : undefined;
  const dataUrl = sheetAbs && fs.existsSync(sheetAbs) ? `data:image/png;base64,${fs.readFileSync(sheetAbs).toString('base64')}` : undefined;
  const body = {
    model: cfg.judge.model || 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a strict but fair visual fidelity reviewer. Answer with JSON only.' },
      { role: 'user', content: [{ type: 'text', text: fs.readFileSync(path.resolve(path.dirname(bundlePath), 'prompt.md'), 'utf8') }, ...(dataUrl ? [{ type: 'image_url', image_url: { url: dataUrl } }] : [])] },
    ],
  };
  try {
    const res = await fetch(`${cfg.judge.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.judge.key}` }, body: JSON.stringify(body),
    });
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content ?? '';
    const verdict = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
    let out = path.resolve(str(A.out, 'judge/verdict.json'));
    try { if (fs.statSync(out).isDirectory()) out = path.join(out, 'verdict.json'); } catch { }
    writeJson(out, { ...verdict, _meta: { model: body.model, at: stamp(), source: 'api' } });
    summary('judge-call', { ok: true, verdict: verdict.verdict, regions: verdict.regions?.length ?? 0, out: rel(out, process.cwd()) });
  } catch (err) {
    summary('judge-call', { ok: false, error: String(err).slice(0, 200) });
    process.exit(1);
  }
}

function verify() {
  const file = path.resolve(str(A.file, 'judge/verdict.json'));
  const bundlePath = path.resolve(str(A.bundle, 'judge/bundle.json'));
  const v = readJsonSafe(file);
  const b = readJsonSafe(bundlePath);
  if (!v) usage('judge.mjs verify --file judge/verdict.json [--bundle judge/bundle.json]');
  const errors = [];
  if (!['pass', 'fail'].includes(v.verdict)) errors.push(`verdict must be pass|fail (got ${JSON.stringify(v.verdict)})`);
  if (!Array.isArray(v.regions)) errors.push('regions[] missing');
  // Models routinely echo "hero@390" into both name and width; strip an @width
  // suffix before matching so a correct verdict is not rejected on formatting.
  const keyOf = (r) => `${String(r.name ?? '').replace(/@\d+$/, '')}@${r.width}`;
  const known = new Set((b?.regions ?? []).map(keyOf));
  if (!(v.regions ?? []).length) errors.push('regions[] is empty — a judge that looked at nothing cannot pass');
  const judged = new Set((v.regions ?? []).map(keyOf));
  for (const k of known) if (!judged.has(k)) errors.push(`${k}: not judged (every region in the bundle needs a verdict)`);
  const unfaithful = [];
  for (const r of v.regions ?? []) {
    const key = keyOf(r);
    if (known.size && !known.has(key)) errors.push(`unknown region ${key} (judge invented it?)`);
    if (typeof r.faithful !== 'boolean') errors.push(`${key}: faithful must be boolean`);
    if (!r.faithful) unfaithful.push({ ...r, key });
  }
  const report = {
    at: stamp(), source: rel(file, process.cwd()), errors, verdict: v.verdict,
    regionsJudged: (v.regions ?? []).length, unfaithful,
    gate: errors.length === 0 && v.verdict === 'pass' && unfaithful.length === 0,
  };
  // Write next to the bundle by default: `--bundle work/judge/bundle.json` must not
  // scatter gate.json into the scripts directory.
  const outDir = path.resolve(str(A.out, path.dirname(bundlePath)));
  writeJson(path.join(outDir, 'final.json'), report);
  writeJson(path.join(outDir, 'gate.json'), { ok: report.gate, verdict: v.verdict, failed: unfaithful.length, regions: report.regionsJudged, at: stamp() });
  summary('judge-verify', { ok: report.gate, verdict: v.verdict, judged: report.regionsJudged, unfaithful: unfaithful.length, schemaErrors: errors.length });
  for (const u of unfaithful) console.log(`  ✗ ${u.key} — ${(u.differences ?? []).map((d) => `${d.severity}: ${d.what}`).join('; ') || 'no detail given'}`);
  for (const e of errors) console.log(`  ! ${e}`);
  process.exit(report.gate ? 0 : 1);
}

switch (cmd) {
  case 'bundle': await bundle(); break;
  case 'call': await call(); break;
  case 'verify': verify(); break;
  default: usage('judge.mjs <bundle|call|verify> [options]');
}
