#!/usr/bin/env node
// SPEC — `spec.json` is the single source of truth; SPEC.md and validation.json
// are GENERATED from it, so the author writes values (small JSON), not prose.
//
//   node spec.mjs init  --dir import [--width 1366] [--out spec/spec.json] [--name hero]
//   node spec.mjs check --spec spec/spec.json
//   node spec.mjs build --spec spec/spec.json [--project .] [--url http://localhost:3000]
//   node spec.mjs css   --spec spec/spec.json [--emit css|tailwind|scss]
//   node spec.mjs drift --spec spec/spec.json --dir import
import path from 'node:path';
import fs from 'node:fs';
import {
  parseArgs, num, str, flag, csv, readJsonSafe, readNdjson, writeJson, writeText, ensureDir,
  parseColor, toHex, contrast, wcagLevel, rel, usage, summary, slug, stamp, humanBytes,
} from './lib/core.mjs';
import { solveScale, cssVar, lintTokens, fmt, parsePx, SCALE_HEADER } from './lib/scale.mjs';
import { loadRules, selectRules, renderProhibitions } from './lib/rules.mjs';

const A = parseArgs();
const cmd = String(A._[0] ?? (flag(A.init) ? 'init' : 'build'));

/* --------------------------------------------------------------- helpers --- */

const kebab = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
const PROPS = {
  padTop: 'padding-top', padRight: 'padding-right', padBottom: 'padding-bottom', padLeft: 'padding-left',
  marginTop: 'margin-top', marginBottom: 'margin-bottom', gap: 'gap',
  width: 'width', height: 'height', fontSize: 'font-size', lineHeight: 'line-height',
  letterSpacing: 'letter-spacing', borderRadius: 'border-radius', color: 'color', background: 'background-color',
};
const SHORTHAND = ['padTop', 'padRight', 'padBottom', 'padLeft'];
function expandBox(short, prefix) {
  const parts = String(short ?? '').trim().split(/\s+/);
  if (!parts.length || !/^-?[\d.]+px/.test(parts[0])) return {};
  const [a, b = a, c = a, d = b] = parts;
  return { [`${prefix}Top`]: a, [`${prefix}Right`]: b, [`${prefix}Bottom`]: c, [`${prefix}Left`]: d };
}
function nodeProps(it) {
  const L = it.L ?? {};
  const props = {
    ...expandBox(L.pad, 'pad'), ...expandBox(L.mar, 'margin'),
    gap: L.gap, width: L.w, fontSize: it.fs, lineHeight: it.lh,
    letterSpacing: it.ls && it.ls !== 'normal' ? it.ls : undefined,
    borderRadius: it.br,
  };
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (v === undefined || v === null || v === 'normal' || v === 'auto' || v === '0px') delete props[k];
  }
  return props;
}
const keyOf = (it) => `${it.tag}|${(it.cls ?? '').split(/\s+/).slice(0, 2).join('.')}|${(it.text ?? '').slice(0, 40)}`;
const selectorOf = (it, siblings = []) => {
  const cls = (it.cls ?? '').split(/\s+/).filter((c) => c && !/^(css-|sc-|jsx-)/.test(c)).slice(0, 2);
  let sel = it.tag + (it.id ? `#${it.id}` : cls.length ? `.${cls.join('.')}` : '');
  if (!it.id && !cls.length) {
    const same = siblings.filter((s) => s.tag === it.tag).length;
    if (same > 1) sel += `:nth-of-type(${siblings.filter((s) => s.tag === it.tag).indexOf(it) + 1})`;
  }
  return sel;
};
const inside = (a, b, tol = 12) => a.box[0] >= b.box[0] - tol && a.box[1] >= b.box[1] - tol
  && a.box[0] + a.box[2] <= b.box[0] + b.box[2] + tol && a.box[1] + a.box[3] <= b.box[1] + b.box[3] + tol;

/* ------------------------------------------------------------------ init --- */

function tokensFromInventory(items) {
  const textColors = new Map(), bgs = new Map(), fonts = new Map(), spaces = new Map(), radii = new Map();
  const bump = (m, k) => { if (k === undefined || k === null) return; m.set(k, (m.get(k) ?? 0) + 1); };
  for (const it of items) {
    if (it.text) bump(textColors, toHex(parseColor(it.color)));
    if (it.bg) bump(bgs, toHex(parseColor(it.bg)));
    if (it.text) bump(fonts, `${it.font}|${it.fw}|${it.fs}|${it.lh}|${it.ls ?? 'normal'}`);
    const p = nodeProps(it);
    for (const v of [p.padTop, p.padRight, p.padBottom, p.padLeft, p.marginTop, p.marginBottom, p.gap]) {
      const n = parsePx(v);
      if (n && n > 0 && n <= 240) bump(spaces, Math.round(n));
    }
    if (it.br) bump(radii, it.br);
  }
  const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const chroma = (hex) => { const c = parseColor(hex); return c ? Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) : 0; };
  const neutral = (c) => chroma(c) < 24;
  const [ink] = rank(textColors)[0] ?? ['#000000'];
  const surface = rank(bgs)[0]?.[0] ?? '#ffffff';
  // surface-alt is the most-used NEUTRAL panel: taking the plain 2nd most-used
  // background picks the accent bar of a CTA band instead of a surface.
  const surfaceAlt = rank(bgs).map(([c]) => c).find((c) => c !== surface && c !== ink && neutral(c)) ?? surface;
  // accent = the most-used colour that is actually a COLOUR; frequency alone
  // picks a grey panel, and a grey "accent" fails every contrast check it enters.
  const spectral = (c) => c !== ink && c !== surface && c !== surfaceAlt && !neutral(c);
  const accent = rank(bgs).map(([c]) => c).find(spectral)
    ?? rank(textColors).map(([c]) => c).find(spectral)
    ?? rank(bgs).map(([c]) => c).find((c) => c !== surface && c !== surfaceAlt && c !== ink) ?? ink;
  // invert against the accent we actually chose (white on a light accent is invisible)
  const inverse = contrast('#ffffff', accent) >= contrast(ink, accent) ? '#ffffff' : ink;
  const fontRank = rank(fonts);
  const maxFs = Math.max(...fontRank.map(([k]) => parsePx(k.split('|')[2]) ?? 0));
  const used = new Set();
  const bodyKey = fontRank[0]?.[0];
  const fontTokens = [];
  for (const [k, n] of fontRank) {
    const [family, weight, size, lh, ls] = k.split('|');
    const role = k === bodyKey ? 'body' : parsePx(size) === maxFs && Number(weight) >= 500 ? 'display' : 'support';
    if (fontTokens.length >= 6) break;
    if (fontTokens.some((f) => f.role === role)) continue;
    if (fontTokens.some((f) => f.family === family && f.weight === weight && f.size === size)) continue;
    used.add(role);
    const letterSpacing = ls && ls !== 'normal' ? ls : undefined;
    fontTokens.push({ role, family, weight: Number(weight), size, lineHeight: lh, letterSpacing, usage: n });
  }
  const spaceVals = rank(spaces).slice(0, 14).map(([v, n]) => ({ px: v, n })).sort((a, b) => a.px - b.px);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const unit = spaceVals.length ? spaceVals.map((s) => s.px).reduce((a, b) => gcd(a, b)) : 8;
  // Radius names must follow SIZE, not frequency: ranking by use made the pill
  // button 999px the "sm" radius and the 8px card the "xl" one.
  const RADII = ['sm', 'md', 'lg', 'xl', '2xl'];
  let rn = 0;
  const radiusVals = rank(radii).slice(0, 5).map(([v, n]) => ({ value: v, n }))
    .sort((a, b) => (parsePx(a.value) ?? 0) - (parsePx(b.value) ?? 0))
    .map((r) => ({ ...r, name: (parsePx(r.value) ?? 0) >= 100 ? 'pill' : (RADII[rn++] ?? `r${parsePx(r.value) ?? 0}`) }));
  return {
    colors: [
      { name: 'ink', hex: ink, role: 'text', usage: textColors.get(ink) ?? 0 },
      ...(surface !== ink ? [{ name: 'surface', hex: surface, role: 'background', usage: bgs.get(surface) ?? 0 }] : []),
      ...(surfaceAlt !== surface ? [{ name: 'surface-alt', hex: surfaceAlt, role: 'background', usage: bgs.get(surfaceAlt) ?? 0 }] : []),
      { name: 'accent', hex: accent, role: 'accent', usage: bgs.get(accent) ?? 0 },
      { name: 'inverse', hex: inverse, role: 'text-on-accent' },
    ],
    fonts: fontTokens,
    space: { unit: unit >= 2 ? unit : 4, steps: spaceVals.map((s) => s.px), usage: spaceVals },
    radius: radiusVals,
  };
}

// Utility classes are shared by every sibling; naming a block after `section`
// makes `--section-padding-top` be declared once per section (and silently
// override each other). Prefer the id, then the first class that is NOT generic.
const GENERIC_CLASSES = new Set(['section', 'container', 'wrap', 'wrapper', 'inner', 'row', 'grid', 'block', 'content', 'page', 'shell', 'band']);
function uniqueBlockName(it, taken) {
  const classes = String(it.cls ?? '').split(/\s+/).filter(Boolean);
  const base = slug(it.id || classes.find((c) => !GENERIC_CLASSES.has(c)) || classes[0] || it.tag || 'block');
  let name = base, i = 2;
  while (taken.has(name)) name = `${base}-${i++}`;
  taken.add(name);
  return name;
}

function blocksFromInventory(items, widthMaps, primary) {
  const blocks = [];
  const taken = new Set();
  const ordered = [...items].sort((a, b) => a.d - b.d || a.box[1] - b.box[1]);
  for (const it of ordered) {
    if (blocks.length >= 12) break;
    if (it.box[3] < 100 || it.box[2] < 240) continue;
    if (blocks.some((b) => inside(it, b.node))) continue;
    const sel = selectorOf(it, items.filter((s) => s.d === it.d));
    const children = [];
    for (const c of ordered.filter((s) => s.d === it.d + 1 && inside(s, it))) {
      if (children.length >= 10) break;
      if (c.box[3] < 18 && !c.text) continue;
      children.push({ node: c, name: slug((c.cls ?? '').split(/\s+/)[0] || c.tag) });
    }
    blocks.push({ node: it, selector: sel, name: uniqueBlockName(it, taken), children });
  }
  // measure every node in every width (matched by stable key) → scale-solver input
  const measure = (node) => {
    const out = {};
    for (const [w, map] of Object.entries(widthMaps)) {
      const found = map.get(keyOf(node));
      if (!found) continue;
      out[w] = { box: found.box, props: nodeProps(found), color: found.color ? toHex(parseColor(found.color)) : undefined, bg: found.bg ? toHex(parseColor(found.bg)) : undefined, fs: found.fs, fw: found.fw, font: found.font };
    }
    return out;
  };
  return blocks.map((b) => ({
    name: b.name, selector: b.selector, role: b.node.landmark ? 'landmark' : 'region',
    measure: measure(b.node),
    children: b.children.map((c) => ({
      name: c.name || slug(c.node.tag), selector: selectorOf(c.node, items.filter((s) => s.d === c.node.d && inside(s, b.node))),
      role: c.node.text ? 'text' : c.node.imgs ? 'media' : 'box',
      measure: measure(c.node),
      copy: c.node.text || undefined,
      imgs: c.node.imgs,
    })),
  }));
}

function copyFromInventory(items) {
  const out = [];
  for (const it of items) {
    if (!it.text) continue;
    out.push({
      id: `c${String(out.length + 1).padStart(2, '0')}`,
      selector: selectorOf(it, items.filter((s) => s.d === it.d)),
      block: slug((it.cls ?? '').split(/\s+/)[0] || it.tag),
      text: it.text,
      chars: it.text.length,
      font: `${it.font} ${it.fw} ${it.fs}`,
    });
  }
  return out;
}

function initSpec() {
  const dir = path.resolve(str(A.dir, 'import'));
  const meta = readJsonSafe(path.join(dir, 'inventory.json'));
  if (!meta) usage(`no inventory.json in ${dir} — run extract.mjs first`);
  const allWidths = meta.widths ?? [];
  const primary = num(A.width, allWidths.at(-1));
  const widthMaps = {};
  for (const w of allWidths) {
    const rows = readNdjson(path.join(dir, `inventory-${w}.ndjson`));
    if (rows.length) widthMaps[w] = new Map(rows.map((r) => [keyOf(r), r]));
  }
  const items = readNdjson(path.join(dir, `inventory-${primary}.ndjson`));
  if (!items.length) usage(`no inventory for width ${primary}`);
  const breaks = readJsonSafe(path.join(dir, 'breaks.json'));
  const run = readJsonSafe(path.join(dir, 'run.json'));
  const assetsFile = readJsonSafe(path.join(dir, 'assets.json'));
  const tokens = tokensFromInventory(items);
  const blocks = blocksFromInventory(items, widthMaps, primary);
  const copy = copyFromInventory(items);
  const spec = {
    $schema: 'fidelity/spec@3',
    name: str(A.name, slug(path.basename(process.cwd()))),
    scope: str(A.scope, ''),
    identity: str(A.identity, 'de-branded'),
    stack: str(A.stack, 'React + TS + plain CSS (no animation/UI/canvas libraries)'),
    source: {
      kind: 'url', url: run?.url ?? meta.url ?? '', capturedAt: run?.finishedAt ?? meta.extractedAt ?? stamp(),
      run: rel(path.join(dir, 'run.json'), process.cwd()), importDir: rel(dir, process.cwd()),
      hashes: run?.hashes ?? Object.fromEntries((meta.pages ?? []).map((p) => [`html@${p.width}`, p.htmlSha256])),
    },
    designWidth: primary,
    widths: allWidths,
    breakpoints: (breaks?.boundaries ?? []).map((px) => ({ px, kind: 'max' })),
    tokens: { ...tokens, screens: Object.fromEntries((breaks?.boundaries ?? []).map((px, i) => [`bp${i + 1}`, `${px + 1}px`])) },
    copy,
    blocks,
    assets: (assetsFile?.images ?? []).slice(0, 40).map((i) => ({
      kind: 'image', url: i.url, dest: `public/assets/${slug(path.basename(new URL(i.url, 'https://x/').pathname)) || 'asset.png'}`,
      w: i.w, h: i.h, alt: i.alt, substituted: false,
    })).concat((assetsFile?.videos ?? []).map((v) => ({
      kind: 'video', url: v.url, dest: `public/assets/${slug(path.basename(new URL(v.url, 'https://x/').pathname)) || 'video.mp4'}`,
      w: v.w, h: v.h, duration: v.duration, substituted: false,
    }))),
    behavior: [],
    responsive: { rules: [], reducedMotion: '' },
    semantics: { lang: assetsFile?.meta?.lang || 'pt-BR', title: assetsFile?.meta?.title ?? '', description: assetsFile?.meta?.description ?? '', aria: [] },
    prohibitions: [],
    tags: [str(A.identity, 'de-branded'), 'clone'],
    noExternal: str(A.identity, 'de-branded') === 'de-branded',
    acceptance: [],
    provenance: { generator: 'spec.mjs init', at: stamp(), inventory: rel(dir, process.cwd()), widths: allWidths, primary },
  };
  spec.acceptance = deriveAcceptance(spec);
  const out = path.resolve(str(A.out, 'spec/spec.json'));
  writeJson(out, spec);
  summary('spec-init', {
    out: rel(out, process.cwd()), primary, blocks: blocks.length, copy: copy.length,
    fonts: tokens.fonts.length, colors: tokens.colors.length, checks: spec.acceptance.length,
    next: `fill name/scope/behavior in ${rel(out, process.cwd())}, then: node spec.mjs check --spec ${rel(out, process.cwd())}`,
  });
}

/* ------------------------------------------------------------ acceptance --- */

function deriveAcceptance(spec) {
  const checks = [];
  const widths = spec.widths ?? [];
  const primary = spec.designWidth ?? widths.at(-1);
  const mobile = widths[0];
  for (const c of spec.copy ?? []) {
    checks.push({ type: 'text', selector: c.selector, equals: c.text, width: primary, from: c.id });
    if (mobile !== primary) checks.push({ type: 'text', selector: c.selector, equals: c.text, width: mobile, from: c.id });
  }
  for (const b of spec.blocks ?? []) {
    for (const w of [primary, mobile].filter((v, i, a) => a.indexOf(v) === i)) {
      const m = b.measure?.[w];
      if (!m) continue;
      checks.push({ type: 'boundingBox', selector: b.selector, width: w, prop: 'width', approxPx: +m.box[2].toFixed(1), tolerancePx: 6, from: `${b.name}.width` });
      checks.push({ type: 'boundingBox', selector: b.selector, width: w, prop: 'height', approxPx: +m.box[3].toFixed(1), tolerancePx: 12, from: `${b.name}.height` });
    }
    const repeated = new Map();
    for (const c of b.children ?? []) {
      const cls = c.selector?.split('.').slice(1).join('.');
      if (cls) repeated.set(cls, (repeated.get(cls) ?? 0) + 1);
    }
    for (const [cls, n] of repeated) if (n >= 3) checks.push({ type: 'count', selector: `.${cls}`, equals: n, width: primary, from: `${b.name}.items` });
  }
  const fontSeen = new Set();
  for (const c of spec.copy ?? []) {
    const m = (spec.blocks ?? []).flatMap((b) => b.children ?? []).find((ch) => ch.selector === c.selector)?.measure?.[primary];
    const merge = m ?? null;
    const key = `${c.selector}`;
    if (fontSeen.has(key)) continue;
    fontSeen.add(key);
    if (merge?.fw) checks.push({ type: 'style', selector: c.selector, width: primary, prop: 'font-weight', equals: String(merge.fw), from: `${c.id}.weight` });
    if (merge?.fs) checks.push({ type: 'style', selector: c.selector, width: primary, prop: 'font-size', equals: merge.fs, tolerancePx: 0.5, from: `${c.id}.size` });
    if (merge?.color) checks.push({ type: 'style', selector: c.selector, width: primary, prop: 'color', equals: toHex(parseColor(merge.color)), colorTolerance: 6, from: `${c.id}.color` });
  }
  for (const f of spec.tokens?.fonts ?? []) {
    checks.push({ type: 'font', family: f.family, weight: f.weight, from: `font.${f.role}` });
  }
  for (const a of spec.assets ?? []) {
    if (a.kind === 'video' && !a.substituted) checks.push({ type: 'exists', selector: 'video', width: primary, from: 'asset.video' });
  }
  if (spec.noExternal && spec.source?.url) {
    let host = ''; try { host = new URL(spec.source.url).host; } catch { }
    if (host) checks.push({ type: 'noRequest', denyHosts: [host], from: 'de-branded' });
  }
  // Interactions declared in the spec become executable checks: `hover`, `focus`,
  // `scroll` and `probe` are state transitions, not static styles. A behavior entry
  // without `check` stays prose (measured in SPEC.md, not enforced).
  for (const b of spec.behavior ?? []) {
    for (const c of [].concat(b.check ?? b.checks ?? [])) {
      if (!c || typeof c !== 'object' || !c.type) continue;
      checks.push({ ...c, from: c.from ?? `behavior:${b.what ?? b.id ?? 'interaction'}` });
    }
  }
  return checks;
}

/** Derived checks are the source of truth; hand-written ones (no `from`) survive an edit. */
function acceptanceFor(spec) {
  const manual = (spec.acceptance ?? []).filter((c) => c && c.type && !c.from);
  return [...deriveAcceptance(spec), ...manual];
}

/* ---------------------------------------------------------------- layout --- */

function solveNode(name, measure, extra = {}) {
  const widths = Object.keys(measure).map(Number).sort((a, b) => a - b);
  const propNames = new Set();
  for (const m of Object.values(measure)) for (const k of Object.keys(m.props ?? {})) propNames.add(k);
  const vars = [], constants = [], unresolved = [];
  for (const p of propNames) {
    const points = widths.filter((w) => measure[w]?.props?.[p] !== undefined).map((w) => ({ w, value: measure[w].props[p] }));
    if (!points.length) continue;
    const sol = solveScale(points);
    if (!sol.css) continue;
    if (sol.kind === 'constant') constants.push({ prop: PROPS[p] ?? p, value: sol.css, n: points.length });
    else vars.push({ prop: PROPS[p] ?? p, name: `${name}-${kebab(PROPS[p] ?? p)}`, sol });
  }
  for (const key of ['color', 'background']) {
    const vals = widths.map((w) => measure[w]?.[key]).filter(Boolean);
    const uniq = [...new Set(vals)];
    if (uniq.length === 1) constants.push({ prop: key === 'color' ? 'color' : 'background-color', value: uniq[0], n: vals.length });
    else if (uniq.length > 1) unresolved.push({ prop: key, values: uniq });
  }
  const fw = [...new Set(widths.map((w) => measure[w]?.fw).filter(Boolean))];
  const fonts = [...new Set(widths.map((w) => measure[w]?.font).filter(Boolean))];
  return { vars, constants, unresolved, fonts: fonts.length === 1 ? fonts[0] : fonts, weights: fw, widths };
}

function layoutCss(spec) {
  const lines = [SCALE_HEADER, '', ':root {'];
  const rootMedia = [];
  const blockCss = [];
  for (const b of spec.blocks ?? []) {
    const solved = solveNode(b.name, b.measure ?? {});
    lines.push(`  /* ${b.name} — ${b.selector}${b.measure?.[spec.designWidth] ? ` box ${b.measure[spec.designWidth].box.join(', ')}` : ''} */`);
    for (const v of solved.vars) {
      const block = cssVar(v.name, v.sol, { media: false });
      lines.push(block);
      if (v.sol.media?.length) rootMedia.push(`@media (min-width: ${v.sol.media[0].minWidth}px) {\n${v.sol.media.map((m) => `  :root { --${v.name}: ${m.value}; }`).join('\n')}\n}`);
    }
    const decl = [];
    if (solved.fonts && typeof solved.fonts === 'string') decl.push(`  font-family: "${solved.fonts}", var(--font-fallback);`);
    if (solved.weights?.length === 1) decl.push(`  font-weight: ${solved.weights[0]};`);
    for (const c of solved.constants) decl.push(`  ${c.prop}: ${c.value};`);
    for (const v of solved.vars) decl.push(`  ${v.prop}: var(--${v.name});`);
    blockCss.push(`/* ${b.name} */\n.${b.name} {\n${decl.join('\n') || '  /* all values are constants already declared above */'}\n}`);
    for (const c of b.children ?? []) {
      const cs = solveNode(`${b.name}-${c.name}`, c.measure ?? {});
      const cd = [];
      for (const v of cs.vars) {
        lines.push(cssVar(v.name, v.sol, { media: false }));
        if (v.sol.media?.length) rootMedia.push(`@media (min-width: ${v.sol.media[0].minWidth}px) {\n${v.sol.media.map((m) => `  :root { --${v.name}: ${m.value}; }`).join('\n')}\n}`);
        cd.push(`  ${v.prop}: var(--${v.name});`);
      }
      for (const k of cs.constants) cd.push(`  ${k.prop}: ${k.value};`);
      if (cs.weights?.length === 1) cd.unshift(`  font-weight: ${cs.weights[0]};`);
      blockCss.push(`/* ${b.name} > ${c.name} (${c.selector}) */\n.${b.name} .${c.name} {\n${cd.join('\n') || '  /* nothing measured */'}\n}`);
    }
  }
  if (lines.length === 2) lines.push('  /* no block measurements — run spec.mjs init against an extract run */');
  lines.push('}', '', ...rootMedia, '', ...blockCss);
  return lines.join('\n');
}

function tokensCss(spec) {
  const t = spec.tokens ?? {};
  const out = ['/* generated from spec.json — do not hand-edit; re-run: node spec.mjs build */', '', ':root {'];
  for (const c of t.colors ?? []) out.push(`  --color-${kebab(c.name)}: ${c.hex};  /* ${c.role}${c.usage ? `, ${c.usage} uses` : ''} */`);
  // Every font stack ends in this var; defining it here is what makes the emitted
  // CSS valid on its own (an undefined var() silently kills the whole declaration).
  out.push('  --font-fallback: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;');
  for (const f of t.fonts ?? []) {
    // Point at the @font-face that carries size-adjust/ascent-override, not at the
    // raw local family: the whole point of the metric-compatible fallback is the
    // adjustment, and referencing the plain name throws it away.
    const fbName = f.fallback?.family ? `"Fallback ${kebab(f.role)}", ` : '';
    out.push(`  --font-${kebab(f.role)}: "${f.family}", ${fbName}var(--font-fallback);`);
    if (f.size) out.push(`  --size-${kebab(f.role)}: ${f.size};`);
    if (f.lineHeight) out.push(`  --leading-${kebab(f.role)}: ${f.lineHeight};`);
    if (f.letterSpacing) out.push(`  --tracking-${kebab(f.role)}: ${f.letterSpacing};`);
  }
  if (t.space?.unit) out.push(`  --space-unit: ${t.space.unit}px;`);
  (t.space?.steps ?? []).forEach((px, i) => out.push(`  --space-${i + 1}: ${px}px;`));
  for (const r of t.radius ?? []) out.push(`  --radius-${kebab(r.name)}: ${r.value};`);
  out.push('}', '', 'html { font-family: var(--font-body, system-ui), sans-serif; color: var(--color-ink); background: var(--color-surface); }');
  for (const f of t.fonts ?? []) {
    const srcList = (f.src ?? []).map((u) => `url("${u}") format("${/\.woff2/i.test(u) ? 'woff2' : /\.woff/i.test(u) ? 'woff' : 'truetype'}")`).join(', ');
    const fb = f.fallback;
    out.push('', `/* ${f.role}: ${f.family} ${f.weight} ${f.size ?? ''}/${f.lineHeight ?? 'normal'} ${f.letterSpacing ?? ''} · ${f.usage ?? 0} uses */`);
    if (srcList) out.push(`@font-face { font-family: "${f.family}"; font-weight: ${f.weight}; font-display: swap; src: ${srcList}; }`);
    if (fb?.family) {
      out.push(`@font-face {`, `  font-family: "Fallback ${kebab(f.role)}";`, `  src: local("${fb.family}");`,
        `  size-adjust: ${fb.sizeAdjust ?? '100%'};`, fb.ascentOverride ? `  ascent-override: ${fb.ascentOverride};` : null,
        fb.descentOverride ? `  descent-override: ${fb.descentOverride};` : null, fb.lineGapOverride ? `  line-gap-override: ${fb.lineGapOverride};` : null, `}`);
    }
  }
  return out.filter((l) => l !== null).join('\n');
}

function tailwindConfig(spec) {
  const t = spec.tokens ?? {};
  const screens = Object.fromEntries((spec.breakpoints ?? []).map((b) => [`bp-${b.px}`, `${b.px + 1}px`]));
  return `// generated from spec.json — theme tokens + inferred breakpoints
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx,js,jsx,html}', './app/**/*.{ts,tsx,js,jsx}'],
  theme: {
    screens: ${JSON.stringify(screens, null, 6)},
    extend: {
      colors: {
${(t.colors ?? []).map((c) => `        '${kebab(c.name)}': '${c.hex}',`).join('\n')}
      },
      fontFamily: {
${(t.fonts ?? []).map((f) => `        '${kebab(f.role)}': ['${f.family}', 'var(--font-fallback)'],`).join('\n')}
      },
      spacing: {
${(t.space?.steps ?? []).map((px, i) => `        '${i + 1}': '${px}px',`).join('\n')}
      },
      borderRadius: {
${(t.radius ?? []).map((r) => `        '${kebab(r.name)}': '${r.value}',`).join('\n')}
      },
    },
  },
  plugins: [],
};
`;
}

/* ------------------------------------------------------------ SPEC.md gen --- */

function buildSpecMd(spec, { layout, rules }) {
  const W = spec.designWidth;
  const widths = spec.widths ?? [];
  const bps = spec.breakpoints ?? [];
  const l = [];
  const A_ = (s) => l.push(s);
  A_(`# RECONSTRUCTION SPEC — ${spec.name}${spec.scope ? ` (${spec.scope})` : ''}`);
  A_('');
  A_(`Recreate this exact ${spec.scope || 'component/page'} as a pixel-fidelity clone. This is a fidelity task, not a redesign.`);
  A_(`Identity: **${spec.identity}**. Stack: ${spec.stack}. Keep everything local; never publish or deploy.`);
  A_(`Generated by \`spec.mjs build\` from \`spec/spec.json\` at ${stamp()} — edit the JSON, not this file.`);
  A_('');
  A_('## 1. Source authority');
  A_(`Reference: ${spec.source?.kind ?? 'url'} \`${spec.source?.url ?? ''}\`, captured ${spec.source?.capturedAt ?? '?'} (run: \`${spec.source?.run ?? '?'}\`).`);
  A_(`Design width for measurements: **${W}px**. Measured ladder: ${widths.join(', ')}.`);
  A_('The reference values in this document win over any aesthetic judgement. Where this');
  A_('document and the pinned sources in `spec/sources/manifest.json` disagree, the sources win.');
  A_('The selectors below (`.block`, `.block .child`) are the contract for the build DOM —');
  A_('implement them verbatim so `validation.json` measures the same nodes as the reference did.');
  A_('');
  A_('## 2. Exact visible copy');
  A_('Preserve spelling, capitalisation, punctuation, typographic apostrophes and explicit line breaks.');
  A_(`Character counts were measured in the DOM; do not rewrite the copy (it is length-matched to the original).`);
  A_('');
  for (const c of spec.copy ?? []) A_(`- ${c.id} \`${c.selector}\` — ${JSON.stringify(c.text)} (${c.chars} chars${c.font ? `, ${c.font}` : ''})`);
  if (!(spec.copy ?? []).length) A_('_none measured — run `spec.mjs init` against an extract run._');
  A_('');
  A_('## 3. Typography and colours (exact)');
  for (const f of spec.tokens?.fonts ?? []) {
    A_(`- **${f.role}** — \`${f.family}\` weight ${f.weight}, ${f.size ?? '?'}/${f.lineHeight ?? 'normal'}${f.letterSpacing ? `, letter-spacing ${f.letterSpacing}` : ''} (${f.usage ?? 0} uses)`);
    if (f.fallback?.family) A_(`  - fallback: \`${f.fallback.family}\` with size-adjust ${f.fallback.sizeAdjust ?? '100%'}${f.fallback.ascentOverride ? `, ascent-override ${f.fallback.ascentOverride}` : ''}${f.fallback.descentOverride ? `, descent-override ${f.fallback.descentOverride}` : ''}`);
    if (f.src?.length) A_(`  - src: ${f.src.map((s) => `\`${s}\``).join(', ')}`);
  }
  A_('');
  A_('Real font files only; `font-synthesis: none`. Never simulate bold.');
  A_('');
  for (const c of spec.tokens?.colors ?? []) A_(`- **${c.name}** ${c.hex} — ${c.role}${c.usage ? ` (${c.usage} uses)` : ''}`);
  const contrastPairs = [['ink', 'surface'], ['ink', 'surface-alt'], ['inverse', 'accent']];
  const byName = Object.fromEntries((spec.tokens?.colors ?? []).map((c) => [c.name, c.hex]));
  const cLines = contrastPairs.filter(([a, b]) => byName[a] && byName[b])
    .map(([a, b]) => { const r = contrast(parseColor(byName[a]), parseColor(byName[b])); return `${a}/${b} ${r}:1 (${wcagLevel(r)})`; });
  if (cLines.length) A_(`\nContrast: ${cLines.join(' · ')}.`);
  A_('');
  A_(`## 4. Layout (> ${bps.at(-1)?.px ?? 700}px) — generated CSS`);
  A_('```css');
  A_(layout.split('\n').slice(0, 220).join('\n'));
  A_('```');
  A_('Every `clamp()`/`calc()` above came from the scale solver; each line carries its evidence (width:value samples).');
  A_('Copy the values; do not "improve" the spacing.');
  A_('');
  A_(`## 5. Breakpoints (inferred)`);
  A_(bps.length ? bps.map((b) => `- ≤${b.px}px / ≥${b.px + 1}px (${b.kind}-width)`).join('\n') : '_none detected — the layout is fluid; validate the full width ladder._');
  A_('');
  A_('## 6. Assets (exact)');
  for (const a of spec.assets ?? []) {
    A_(`- ${a.kind}: \`${a.url}\` → \`${a.dest}\`${a.w ? ` (${a.w}×${a.h})` : ''}${a.duration ? ` ${a.duration}s` : ''}${a.substituted ? ' **[SUBSTITUTED]**' : ''}${a.process ? `\n  - process: \`${a.process}\`` : ''}`);
  }
  if (!(spec.assets ?? []).length) A_('_none measured._');
  A_('');
  A_('## 7. Behavior (exact)');
  for (const b of spec.behavior ?? []) {
    A_(`- **${b.name}** — ${b.formula ?? ''}`);
    for (const [k, v] of Object.entries(b.vars ?? {})) A_(`  - ${k} = ${JSON.stringify(v)}`);
    for (const c of b.checks ?? []) A_(`  - check: ${c.assert ?? JSON.stringify(c)}`);
  }
  if (!(spec.behavior ?? []).length) A_('_none specified — interactive effects must be described as formula + data, with 3–5 numeric sanity checks._');
  A_('');
  A_('## 8. Responsive / reduced motion');
  for (const r of spec.responsive?.rules ?? []) A_(`- ${r}`);
  if (spec.responsive?.reducedMotion) A_(`- reduced motion: ${spec.responsive.reducedMotion}`);
  A_('');
  A_('## 9. Semantics and metadata');
  A_(`lang=${spec.semantics?.lang ?? '?'}, title=${JSON.stringify(spec.semantics?.title ?? '')}`);
  if (spec.semantics?.description) A_(`description=${JSON.stringify(spec.semantics.description)}`);
  for (const a of spec.semantics?.aria ?? []) A_(`- ${a}`);
  A_('');
  A_('## 10. Constraints and completion checks');
  A_(`- Stack pinned: ${spec.stack}`);
  A_(`- \`validation.json\` holds ${(spec.acceptance ?? []).length} mechanically checkable criteria (generated from this spec).`);
  A_('- Do not add or change content while validating; only style/behaviour may change.');
  A_('- Single escape hatch: import paths / framework plumbing. Everything else is fixed.');
  A_('');
  A_('## Known failure modes');
  A_(renderProhibitions(rules));
  A_('');
  A_('## APPENDIX — authoritative sources');
  A_('Sources are real files on disk (never inlined here — that would duplicate tokens and drift):');
  A_('`spec/sources/manifest.json` lists every source file with its sha256; verify with `node verify.mjs sources`.');
  const src = readJsonSafe(path.resolve('spec/sources/manifest.json'));
  if (src?.files?.length) for (const f of src.files) A_(`- \`${f.path}\` (${f.bytes} bytes, sha256 ${String(f.sha256).slice(0, 12)}…)`);
  else A_('- _manifest not found yet: populate `spec/sources/` before Stage 4._');
  A_('');
  return l.join('\n');
}

/* ----------------------------------------------------------------- build --- */

function loadSpec() {
  const p = path.resolve(str(A.spec, 'spec/spec.json'));
  const spec = readJsonSafe(p);
  if (!spec) usage(`cannot read spec: ${p}`);
  return { spec, path: p };
}

function build() {
  const { spec, path: specPath } = loadSpec();
  // Acceptance follows the spec: editing behavior/copy/blocks after `init` must not
  // leave validation.json checking the old page.
  spec.acceptance = acceptanceFor(spec);
  const baseDir = path.dirname(specPath);
  const rules = selectRules(loadRules(), spec.tags ?? ['clone'], { max: 14 });
  const layout = layoutCss(spec);
  const url = str(A.url, 'http://localhost:3000');
  const widths = csv(str(A.widths)).length ? csv(str(A.widths)) : (spec.widths ?? []).slice(0, 6);
  const validation = {
    url, widths, height: 900, screenshot: true, retries: 2,
    elementShots: Object.fromEntries((spec.blocks ?? []).map((b) => [slug(b.name), b.selector])),
    passes: [{ name: 'default' }, ...(spec.responsive?.reducedMotion ? [{ name: 'reduced-motion', reducedMotion: true, only: ['style', 'font', 'value'] }] : [])],
    checks: spec.acceptance ?? [],
  };
  const files = {
    'SPEC.md': buildSpecMd(spec, { layout, rules }),
    'validation.json': JSON.stringify(validation, null, 2) + '\n',
    'tokens.css': tokensCss(spec),
    'layout.css': layout + '\n',
    'tailwind.config.cjs': tailwindConfig(spec),
  };
  const written = [];
  for (const [name, content] of Object.entries(files)) {
    // SPEC.md stays next to spec.json; runnable artifacts go one level up (project root)
    const dest = path.resolve(name === 'SPEC.md' ? baseDir : (str(A.project, '.')), name);
    writeText(dest, content);
    written.push(rel(dest, process.cwd()));
  }
  const lint = lintTokens(spec.tokens ?? {});
  const solved = countSolutions(layout);
  writeJson(path.join(baseDir, 'report.json'), {
    generatedAt: stamp(), spec: rel(specPath, process.cwd()),
    files: written, checks: validation.checks.length, elementShots: Object.keys(validation.elementShots).length,
    scaleSolver: solved, lint,
    next: ['node verify.mjs sources --manifest spec/sources/manifest.json', `node validate.mjs --checks validation.json --out report --url ${url}`],
  });
  summary('spec-build', { files: written, checks: validation.checks.length, fluid: solved.fluid, stepped: solved.steps, lintErrors: lint.filter((i) => i.level === 'error').length });
  for (const i of lint.filter((x) => x.level !== 'info')) console.log(`  ${i.level === 'error' ? '✗' : '!'} ${i.target}: ${i.msg}`);
}
function countSolutions(css) {
  return {
    fluid: (css.match(/clamp\(/g) ?? []).length,
    steps: (css.match(/@media/g) ?? []).length,
    vars: (css.match(/^\s*--[\w-]+:/gm) ?? []).length,
  };
}

function check() {
  const { spec, path: specPath } = loadSpec();
  spec.acceptance = acceptanceFor(spec);
  const errors = [], warnings = [];
  if (!spec.name) errors.push('name is empty');
  if (!spec.source?.url) warnings.push('source.url is empty — provenance is untraceable');
  for (const c of spec.copy ?? []) {
    if (c.chars !== c.text?.length) errors.push(`copy ${c.id}: chars=${c.chars} but text.length=${c.text?.length} — recount, do not guess`);
    if (!c.selector) errors.push(`copy ${c.id}: missing selector`);
  }
  for (const c of spec.tokens?.colors ?? []) if (!parseColor(c.hex)) errors.push(`color ${c.name}: "${c.hex}" is not a parseable colour`);
  for (const f of spec.tokens?.fonts ?? []) {
    if (!f.family) errors.push(`font ${f.role}: missing family`);
    if (!f.size && !f.lineHeight) warnings.push(`font ${f.role}: no measured size/line-height`);
    if (!f.fallback?.family && (f.src ?? []).some((u) => /^https?:/i.test(u))) warnings.push(`font ${f.role}: hotlinked with no metric-compatible local fallback`);
  }
  for (const b of spec.blocks ?? []) {
    if (!b.selector) errors.push(`block ${b.name}: missing selector`);
    if (!Object.keys(b.measure ?? {}).length) errors.push(`block ${b.name}: no measurements (scale solver has nothing to solve)`);
  }
  for (const a of spec.assets ?? []) {
    if (!a.dest) errors.push(`asset ${a.url}: no local dest`);
    if (a.kind === 'video' && !a.process && !a.substituted) warnings.push(`asset ${a.url}: video with no processing command`);
  }
  if (!(spec.acceptance ?? []).length) errors.push('acceptance is empty — nothing would be validated');
  else {
    const badType = (spec.acceptance ?? []).filter((c) => !c.type);
    if (badType.length) errors.push(`${badType.length} acceptance entries without a type`);
    if ((spec.acceptance ?? []).length < 5) warnings.push('fewer than 5 acceptance checks — very thin validation');
  }
  if (!(spec.prohibitions ?? []).length && !(spec.tags ?? []).length) warnings.push('no tags → the generated SPEC gets no pitfall rules injected');
  if (!(spec.behavior ?? []).length) warnings.push('behavior is empty — interactions/animations will not be validated');
  for (const i of lintTokens(spec.tokens ?? {})) (i.level === 'error' ? errors : warnings).push(`[${i.target}] ${i.msg}`);
  const report = { spec: rel(specPath, process.cwd()), errors, warnings, checks: (spec.acceptance ?? []).length, blocks: (spec.blocks ?? []).length, copy: (spec.copy ?? []).length };
  writeJson(path.join(path.dirname(specPath), 'check.json'), report);
  summary('spec-check', { errors: errors.length, warnings: warnings.length, checks: report.checks });
  for (const e of errors) console.log(`  ✗ ${e}`);
  for (const w of warnings.slice(0, 8)) console.log(`  ! ${w}`);
  if (warnings.length > 8) console.log(`  ! … ${warnings.length - 8} more warnings (spec/check.json)`);
  process.exit(errors.length ? 1 : 0);
}

function css() {
  const { spec } = loadSpec();
  const emit = str(A.emit, 'css');
  const text = emit === 'tailwind' ? tailwindConfig(spec) : layoutCss(spec) + '\n\n' + tokensCss(spec);
  if (A.out) { writeText(path.resolve(String(A.out)), text); summary('spec-css', { out: rel(path.resolve(String(A.out)), process.cwd()), emit, bytes: text.length }); }
  else process.stdout.write(text);
}

function drift() {
  const { spec } = loadSpec();
  const dir = path.resolve(str(A.dir, spec.source?.importDir ?? 'import'));
  const run = readJsonSafe(path.join(dir, 'run.json'));
  const issues = [];
  if (run?.hashes) {
    for (const [k, h] of Object.entries(spec.source?.hashes ?? {})) {
      if (run.hashes[k] && run.hashes[k] !== h) issues.push({ kind: 'html-changed', at: k, spec: h.slice(0, 10), now: run.hashes[k].slice(0, 10) });
    }
  }
  const primary = spec.designWidth ?? (spec.widths ?? []).at(-1);
  const rows = readNdjson(path.join(dir, `inventory-${primary}.ndjson`));
  const map = new Map(rows.map((r) => [keyOf(r), r]));
  const tol = num(A.tolerance, 2);
  // compare measured boxes of blocks/children
  const checkNode = (label, selector, measure) => {
    const m = measure?.[primary];
    if (!m) return;
    const row = rows.find((r) => selectorFromRow(r) === selector) ?? [...map.values()].find((r) => `${r.tag}${r.cls ? '.' + r.cls.split(/\s+/).slice(0, 2).join('.') : ''}` === selector);
    if (!row) { issues.push({ kind: 'selector-missing', at: label, selector }); return; }
    const d = [0, 1, 2, 3].map((i) => Math.abs(row.box[i] - m.box[i]));
    const worst = Math.max(...d);
    if (worst > tol) issues.push({ kind: 'geometry-changed', at: label, selector, spec: m.box, now: row.box, deltaPx: +worst.toFixed(1) });
  };
  for (const b of spec.blocks ?? []) {
    checkNode(b.name, b.selector, b.measure);
    for (const c of b.children ?? []) checkNode(`${b.name}>${c.name}`, c.selector, c.measure);
  }
  const report = { spec: rel(path.resolve(str(A.spec, 'spec/spec.json')), process.cwd()), dir: rel(dir, process.cwd()), checkedAt: stamp(), issues };
  writeJson(path.resolve(str(A.out, 'spec/drift.json')), report);
  summary('spec-drift', { issues: issues.length, htmlChanged: issues.filter((i) => i.kind === 'html-changed').length, geometry: issues.filter((i) => i.kind === 'geometry-changed').length });
  for (const i of issues.slice(0, 10)) console.log(`  ${i.kind === 'html-changed' ? '✗' : '!'} ${i.kind} ${i.at}${i.deltaPx ? ` Δ${i.deltaPx}px` : ''}`);
  process.exit(issues.some((i) => i.kind === 'html-changed') ? 1 : 0);
}
function selectorFromRow(r) {
  return r.tag + (r.id ? `#${r.id}` : (r.cls ?? '').split(/\s+/).filter((c) => c && !/^(css-|sc-|jsx-)/.test(c)).slice(0, 2).map((c) => `.${c}`).join(''));
}

/* ------------------------------------------------------------------ main --- */

switch (cmd) {
  case 'init': initSpec(); break;
  case 'check': check(); break;
  case 'build': build(); break;
  case 'css': css(); break;
  case 'drift': drift(); break;
  default: usage(`spec.mjs <init|check|build|css|drift> [options]\n  init  --dir import [--width 1366] [--out spec/spec.json]\n  check --spec spec/spec.json\n  build --spec spec/spec.json [--url http://localhost:3000] [--project .]\n  css   --spec spec/spec.json [--emit css|tailwind] [--out file]\n  drift --spec spec/spec.json --dir import`);
}
