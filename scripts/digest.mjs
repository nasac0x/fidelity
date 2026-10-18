#!/usr/bin/env node
// DIGEST — the ONLY supported way to read an extracted inventory.
// Turns inventory-<w>.ndjson into a small, structured text report (or JSON) that
// fits in a few hundred tokens, instead of shipping thousands of raw nodes.
//
//   node digest.mjs --dir import --width 1366 --outline
//   node digest.mjs --dir import --width 1366 --copy            # copy inventory + char counts
//   node digest.mjs --dir import --width 1366 --styles
//   node digest.mjs --dir import --width 1366 --region 800-1800
//   node digest.mjs --dir import --width 700 --vs 1366          # responsive deltas
import path from 'node:path';
import { parseArgs, num, str, flag, readNdjson, readJsonSafe, writeText, rel, usage, colorDistance, parseColor, toHex, round } from './lib/core.mjs';

const A = parseArgs();
const dir = path.resolve(str(A.dir, str(A.in, 'import')));
const meta = readJsonSafe(path.join(dir, 'inventory.json'));
if (!meta && !A.file) usage('Usage: node digest.mjs --dir <import> --width <w> [--outline|--copy|--styles|--flat|--vs <w>] [--region y0-y1] [--max N] [--depth N]');

const widths = (meta?.widths ?? []).filter((w) => !A.width || Number(A.width) === w);
const load = (w) => readNdjson(path.join(dir, `inventory-${w}.ndjson`));

function region(it) {
  if (!A.region) return true;
  const [y0, y1] = String(A.region).split('-').map(Number);
  const y = it.box[1];
  return y >= (y0 || 0) - 40 && y <= (y1 ?? 1e9);
}
function matchSel(it) {
  if (!A.selector) return true;
  const s = String(A.selector).split(';;').map((x) => x.trim()).filter(Boolean);
  return s.some((needle) => (it.cls ?? '').includes(needle) || it.id === needle || it.tag === needle || (it.text ?? '').includes(needle));
}
const keep = (it) => region(it) && matchSel(it);
const parsePx = (v) => { const m = String(v ?? '').match(/-?[\d.]+/); return m ? Number(m[0]) : undefined; };

function header(w, items, all) {
  const p = meta?.pages?.find((x) => x.width === w) ?? {};
  const total = Array.isArray(all) ? all.length : all;
  const filtered = total !== items.length ? `/${total}` : '';
  return `# ${str(A.title, meta?.focus === 'body' ? 'page' : meta?.focus ?? 'page')} @${w}px  nodes=${items.length}${filtered}
#   scrollHeight=${p.scrollHeight}px  density=${p.density ?? '?'} viewports  truncated=${p.truncated ?? '?'}${filtered ? `  filter: ${A.region ? `y${A.region} ` : ''}${A.selector ? `sel:${A.selector.slice(0, 40)}` : ''}` : ''}
#   config: --max ${num(A.max, 80)} --depth ${num(A.depth, 12)}${A.region ? ` --region ${A.region}` : ''}${A.selector ? ` --selector ${A.selector}` : ''}`;
}

function outline(items, maxLines, maxDepth) {
  const lines = [];
  for (const it of items) {
    if (it.d > maxDepth) continue;
    const indent = '  '.repeat(Math.min(it.d, 8));
    const name = `${it.tag}${it.id ? `#${it.id}` : ''}${it.cls ? `.${it.cls.split(/\s+/).slice(0, 2).join('.')}` : ''}`;
    const [, y, w, h] = it.box;
    const box = `x${String(Math.round(it.box[0])).padStart(4)} y${String(Math.round(y)).padStart(5)} ${String(Math.round(w)).padStart(4)}×${String(Math.round(h)).padStart(4)}`;
    const label = it.text ? `"${it.text.length > 70 ? it.text.slice(0, 69) + '…' : it.text}"` : it.imgs ? `[img ${it.imgs.length}]` : it.bgi ? '[bg-image]' : it.bg ? `[bg ${it.bg}]` : '';
    const type = it.text ? ` ${it.fw ?? ''} ${it.fs ?? ''}/${it.lh ?? ''} ${it.ls && it.ls !== 'normal' ? `ls${it.ls} ` : ''}${it.color ?? ''}` : '';
    const odds = [it.pos && `pos:${it.pos}`, it.ov && `ov:${it.ov}`, it.op && `op:${it.op}`, it.tr && 'transform'];
    const L = it.L ?? {};
    for (const [k, v] of Object.entries(L)) odds.push(`${k}:${String(v).replace(/\s+/g, '_')}`);
    const odd = odds.filter(Boolean).join(' ');
    lines.push(`${indent}${name.padEnd(Math.max(8, 34 - indent.length)).slice(0, 34 - indent.length)} ${box} ${label}${type}${odd ? ` [${odd}]` : ''}`.replace(/\s+$/, ''));
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function copy(items) {
  const REF = 52;
  const lines = [`${'idx'.padStart(3)}  ${'len'.padStart(3)}  ${'tag.reference'.padEnd(REF)} string`];
  let i = 0;
  for (const it of items) {
    if (!it.text) continue;
    i++;
    const ref = `${it.tag}${it.cls ? '.' + it.cls.split(/\s+/)[0] : ''}`;
    lines.push(`${String(i).padStart(3)}  ${String(it.text.length).padStart(3)}  ${ref.padEnd(REF).slice(0, REF)} ${JSON.stringify(it.text)}`);
  }
  lines.push(`# ${i} strings. Character counts come from the DOM (collapsed whitespace).`);
  return lines;
}

function styles(items) {
  const groups = {
    'FONTS (element.computed)': new Map(),
    'COLORS / text': new Map(),
    'COLORS / background': new Map(),
    'RADII': new Map(),
    'BG IMAGES': new Map(),
    'POSITIONING': new Map(),
  };
  const bump = (map, key) => { if (!key) return; const e = map.get(key) ?? { n: 0, ex: [] }; e.n++; if (e.ex.length < 2) e.ex.push(`${it.tag}${it.cls ? '.' + it.cls.split(/\s+/)[0] : ''}`); map.set(key, e); };
  let it;
  for (it of items) {
    if (it.text) bump(groups['FONTS (element.computed)'], `${it.font} ${it.fw} ${it.fs}/${it.lh} ls=${it.ls ?? 'normal'} ${toHex(parseColor(it.color))}`);
    if (it.text) bump(groups['COLORS / text'], toHex(parseColor(it.color)));
    bump(groups['COLORS / background'], it.bg && toHex(parseColor(it.bg)));
    bump(groups['RADII'], it.br);
    bump(groups['BG IMAGES'], it.bgi ? it.bgi.slice(0, 60) : undefined);
    bump(groups['POSITIONING'], it.pos || it.ov ? `${it.pos ?? ''}${it.ov ? ` ov:${it.ov}` : ''}`.trim() : undefined);
  }
  const out = [];
  for (const [title, map] of Object.entries(groups)) {
    if (!map.size) continue;
    out.push(`## ${title}`);
    for (const [k, e] of [...map.entries()].sort((a, b) => b[1].n - a[1].n)) out.push(`  ${String(e.n).padStart(3)}× ${k}    (e.g. ${e.ex.join(', ')})`);
  }
  return out;
}

/** Responsive delta: match nodes by tag+class+text between two widths. */
function vs(base, other, otherW) {
  const NW = 42, CW = 7, max = num(A.max, 80);
  const key = (it) => `${it.tag}|${(it.cls ?? '').split(/\s+/).slice(0, 2).join('.')}|${(it.text ?? '').slice(0, 40)}`;
  // A multiset, not a Map: repeated blocks (5 identical cards) must match 1:1,
  // and among same-key candidates pick the one nearest in space.
  const pool = new Map();
  for (const it of other) { const arr = pool.get(key(it)) ?? []; arr.push(it); pool.set(key(it), arr); }
  const lines = [`${'idx'.padStart(3)}  ${'node'.padEnd(NW)}${['Δx', 'Δy', 'Δw', 'Δh'].map((c) => c.padStart(CW)).join('')}   fs ${otherW}→${Number(A.width)}   note`];
  // Match the WHOLE base list first (never stop early: an early break would make
  // every unmatched node look "gone", which is how a truncated run lies).
  const changed = [], added = [];
  for (const it of base) {
    const arr = pool.get(key(it));
    let o;
    if (arr && arr.length) {
      let best = 0, bestCost = Infinity;
      for (let j = 0; j < arr.length; j++) {
        const cost = Math.abs(arr[j].box[1] - it.box[1]) + Math.abs(arr[j].box[0] - it.box[0]) * 0.25;
        if (cost < bestCost) { bestCost = cost; best = j; }
      }
      o = arr.splice(best, 1)[0];
      if (!arr.length) pool.delete(key(it));
    }
    if (!o) { if (it.text || it.landmark) added.push(it); continue; }
    const d = [0, 1, 2, 3].map((k) => round(it.box[k] - o.box[k], 1));
    if (d.every((v) => Math.abs(v) < 1) && it.fs === o.fs) continue;
    changed.push({ it, o, d });
  }
  const gone = [...pool.values()].flat().filter((o) => o.text || o.landmark);
  let i = 0;
  const row = (idxs, k, tail) => `${String(idxs).padStart(3)}  ${k.slice(0, NW).padEnd(NW)}${tail}`;
  for (const { it, o, d } of changed) {
    if (i >= max) break;
    lines.push(row(++i, key(it), `${d.map((v) => String(v).padStart(CW)).join('')}  ${o.fs}→${it.fs}${Math.abs(d[0]) > 60 ? '  ⚠x-shift' : ''}${it.fs !== o.fs ? '  ⚠font-size' : ''}`));
  }
  for (const it of added) {
    if (i >= max) break;
    lines.push(row(++i, key(it), `${'—'.padStart(CW)} NEW at ${Number(A.width)}`));
  }
  for (const o of gone) {
    if (i >= max) break;
    i++;
    lines.push(`${' '.repeat(5)}${key(o).slice(0, NW).padEnd(NW)}${'—'.padStart(CW)} GONE at ${Number(A.width)} (hid at ${otherW})`);
  }
  const total = changed.length + added.length + gone.length;
  if (total > i) lines.push(`# … ${total - i} more responsive changes hidden (raise --max)`);
  if (lines.length === 1) lines.push('  (no structural/size changes above 1px — layout is stable between these widths)');
  return lines;
}

const maxLines = num(A.max, 80);
const out = [];
if (!widths.length) usage(`no inventory for width ${A.width}; available: ${(meta?.widths ?? []).join(', ')}`);

for (const w of widths) {
  const all = load(w);
  if (!all.length) { out.push(`# no nodes for ${w}px`); continue; }
  const items = all.filter(keep);
  out.push(header(w, items, all));
  if (A.vs) {
    out.push(...vs(items, load(Number(A.vs)).filter(keep), Number(A.vs)));
  } else if (flag(A.copy)) out.push(...copy(items));
  else if (flag(A.styles)) out.push(...styles(items));
  else if (flag(A.flat)) {
    out.push('y      x     w     h   tag.cls                                    text');
    for (const it of items.slice(0, maxLines)) {
      out.push(`${String(Math.round(it.box[1])).padStart(6)} ${String(Math.round(it.box[0])).padStart(5)} ${String(Math.round(it.box[2])).padStart(5)} ${String(Math.round(it.box[3])).padStart(5)}  ${`${it.tag}${it.cls ? '.' + it.cls.split(/\s+/).slice(0, 2).join('.') : ''}`.padEnd(40).slice(0, 40)} ${it.text ? JSON.stringify(it.text.slice(0, 60)) : ''}`);
    }
  } else out.push(...outline(items, maxLines, num(A.depth, 12)));
  const sensitive = items.filter((it) => (it.text || it.imgs || it.landmark));
  if (sensitive.length > maxLines && !A.vs) out.push(`# … ${sensitive.length - maxLines} more nodes hidden (raise --max, or narrow with --region/--depth/--selector)`);
  out.push('');
}

const text = out.join('\n');
if (A.out) { writeText(path.resolve(String(A.out)), text); console.log(`digest ${JSON.stringify({ out: rel(path.resolve(String(A.out)), process.cwd()), lines: out.length })}`); }
else process.stdout.write(text);
