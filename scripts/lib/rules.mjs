// lib/rules.mjs — pitfalls as DATA (rules/pitfalls.jsonl), not prose.
// One rule per line: {id, rule, trigger, tags[], run, hits}
// SPECs are built by selecting rules whose tags match the run, so nobody pastes
// a 90-line file into every document.
import fs from 'node:fs';
import path from 'node:path';
import { RULES_DIR, readNdjson, writeNdjson, ensureDir, readText, writeText, dayStamp } from './core.mjs';

export const RULES_PATH = path.join(RULES_DIR, 'pitfalls.jsonl');
export const MD_VIEW = path.join(RULES_DIR, 'pitfalls.md');

export function loadRules(file = RULES_PATH) {
  const rows = readNdjson(file);
  return rows.map((r, i) => ({
    id: r.id ?? `P-${String(i + 1).padStart(3, '0')}`,
    rule: r.rule ?? '',
    trigger: r.trigger ?? '',
    tags: r.tags ?? [],
    run: r.run ?? '',
    hits: r.hits ?? 0,
    added: r.added ?? '',
  })).filter((r) => r.rule);
}

export function selectRules(rules, tags = [], { max = 14 } = {}) {
  if (!tags.length) return [];
  const wanted = new Set(tags.map((t) => t.toLowerCase()));
  const scored = rules.map((r) => {
    const own = new Set(r.tags.map((t) => t.toLowerCase()));
    // `always` is a real tag on the rule, not something every rule gets: the old
    // version appended it while matching and then granted the bonus for it, so
    // every rule scored and the "inject only what is relevant" filter did nothing.
    const exact = [...wanted].filter((t) => own.has(t)).length;
    const isAlways = own.has('always');
    const hit = r.hits > 0 && exact ? 0.5 : 0;
    return { r, score: exact + hit + (isAlways ? 0.25 : 0) };
  }).filter((s) => s.score > 0.2);
  scored.sort((a, b) => b.score - a.score || b.r.hits - a.r.hits);
  return scored.slice(0, max).map((s) => s.r);
}

export function renderProhibitions(rules) {
  if (!rules.length) return '_No rules matched. Add tags to `rules/pitfalls.jsonl` or extend the spec tags._';
  return rules.map((r) => `- **${r.id}** — Do not ${r.rule.replace(/^do not\s+/i, '')}${r.trigger ? `\n  - because: ${r.trigger}${r.run ? ` (${r.run})` : ''}` : ''}`).join('\n');
}

/** Human-readable view of the same data (generated, never hand-edited). */
export function renderMarkdown(rules) {
  const byTag = new Map();
  for (const r of rules) for (const t of r.tags.length ? r.tags : ['untagged']) {
    if (!byTag.has(t)) byTag.set(t, []);
    byTag.get(t).push(r);
  }
  const lines = [
    '# Pitfalls (generated from rules/pitfalls.jsonl — edit the JSONL, not this file)',
    '',
    `${rules.length} rules. \`hits\` counts how many runs actually tripped the rule.`,
    '',
  ];
  for (const [tag, list] of [...byTag.entries()].sort()) {
    lines.push(`## ${tag}`, '');
    for (const r of list) lines.push(`- **${r.id}** ${r.rule}${r.trigger ? ` — _${r.trigger}_` : ''}${r.hits ? ` · hits=${r.hits}` : ''}${r.run ? ` · ${r.run}` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function bumpHit(id, file = RULES_PATH, run = dayStamp()) {
  const rules = loadRules(file);
  const r = rules.find((x) => x.id === id);
  if (!r) return false;
  r.hits += 1;
  r.lastHit = run;
  writeNdjson(file, rules);
  return true;
}

export function appendRule({ rule, trigger = '', tags = [], run = dayStamp(), id }, file = RULES_PATH) {
  const rules = loadRules(file);
  const nextId = id ?? `P-${String(rules.length + 1).padStart(3, '0')}`;
  rules.push({ id: nextId, rule, trigger, tags, run, hits: 0, added: run });
  writeNdjson(file, rules);
  return nextId;
}

export function syncMarkdown(file = RULES_PATH) {
  ensureDir(RULES_DIR);
  writeText(MD_VIEW, renderMarkdown(loadRules(file)) + '\n');
  return MD_VIEW;
}
export function mdViewExists() { return fs.existsSync(MD_VIEW); }
export function readMarkdown() { return readText(MD_VIEW); }
