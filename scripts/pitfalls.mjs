#!/usr/bin/env node
// PITFALLS — manage rules/pitfalls.jsonl (the "Do not" rules as data).
// SPEC generation injects only the rules whose tags match the run, by id.
//
//   node pitfalls.mjs list [--tag visual]
//   node pitfalls.mjs add --rule "use the exact supplied font" --trigger "swapped for a look-alike" --tags fonts,clone
//   node pitfalls.mjs build --tags clone,fonts,visual [--out spec/prohibitions.md]
//   node pitfalls.mjs sync        # regenerate rules/pitfalls.md (human view)
//   node pitfalls.mjs stats
import path from 'node:path';
import { parseArgs, arr, str, flag, csv, writeText, rel, usage, summary } from './lib/core.mjs';
import { loadRules, selectRules, renderProhibitions, renderMarkdown, appendRule, syncMarkdown, RULES_PATH, MD_VIEW } from './lib/rules.mjs';

const A = parseArgs();
const cmd = String(A._[0] ?? 'list');

switch (cmd) {
  case 'list': {
    const rules = loadRules();
    const tags = csv(str(A.tags, str(A.tag, '')), String);
    const list = tags.length ? selectRules(rules, tags, { max: 999 }) : rules;
    console.log(`# ${list.length} rule(s) of ${rules.length}${tags.length ? ` matching [${tags.join(',')}]` : ''}`);
    for (const r of list) console.log(`  ${r.id}  ${r.tags.join(',') || 'untagged'}  ${r.hits ? `hits=${r.hits}  ` : ''}${r.rule}${r.trigger ? `  [${r.trigger}]` : ''}`);
    break;
  }
  case 'add': {
    const rule = str(A.rule, flag(A.rule) ? '' : undefined) || arr(A._ .slice(1)).join(' ');
    if (!rule) usage('pitfalls.mjs add --rule "..." [--trigger "..."] [--tags a,b] [--run 2026-10-18]');
    const id = appendRule({ rule, trigger: str(A.trigger, ''), tags: csv(str(A.tags, ''), String), run: str(A.run, undefined), id: str(A.id, undefined) });
    syncMarkdown();
    summary('pitfalls-add', { id, rules: loadRules().length, file: rel(RULES_PATH, process.cwd()) });
    break;
  }
  case 'build': {
    const tags = csv(str(A.tags, str(A.tag, 'clone')), String);
    const list = selectRules(loadRules(), tags, { max: Number(str(A.max, '14')) });
    const text = `## Known failure modes\n\nRules injected from \`rules/pitfalls.jsonl\` by tag (${tags.join(', ')}). Each one exists because a run failed exactly that way.\n\n${renderProhibitions(list)}\n`;
    if (A.out) { writeText(path.resolve(String(A.out)), text); summary('pitfalls-build', { rules: list.length, out: rel(path.resolve(String(A.out)), process.cwd()) }); }
    else process.stdout.write(text);
    break;
  }
  case 'sync': {
    const p = syncMarkdown();
    summary('pitfalls-sync', { rules: loadRules().length, out: rel(p, process.cwd()) });
    break;
  }
  case 'stats': {
    const rules = loadRules();
    const byTag = {};
    for (const r of rules) for (const t of (r.tags.length ? r.tags : ['untagged'])) byTag[t] = (byTag[t] ?? 0) + 1;
    summary('pitfalls-stats', { rules: rules.length, tripped: rules.filter((r) => r.hits > 0).length, byTag, file: rel(RULES_PATH, process.cwd()), view: rel(MD_VIEW, process.cwd()) });
    for (const r of rules.filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits)) console.log(`  hits=${r.hits}  ${r.id}  ${r.rule}`);
    break;
  }
  default: usage('pitfalls.mjs <list|add|build|sync|stats> [options]');
}
