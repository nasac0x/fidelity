#!/usr/bin/env node
// FIGMA — read a design file as data (tree, tokens, copy, blocks, images) and draft a
// spec.json the rest of the pipeline can consume. No guessing: every value comes from
// Figma's own node properties.
//
//   node figma.mjs me
//   node figma.mjs pull --file "https://www.figma.com/design/<key>/Name?node-id=1-2" --out spec/figma
//   node figma.mjs pull --file <key> --images --spec-out spec/figma/spec.json
//   node figma.mjs pull --fixture saved-file.json        # offline: parse a saved API response
//
// The draft spec MUST live in its own directory: spec.mjs build writes SPEC.md next to
// the spec.json it is given, so a draft in spec/ would overwrite the real contract.
//
// Token: figma.token in ~/.fidelity.json (or FIGMA_TOKEN). Never printed, never logged.
import path from 'node:path';
import fs from 'node:fs';
import {
  parseArgs, num, str, flag, readJsonSafe, writeJson, ensureDir, rel, usage, summary, slug,
  stamp, loadConfig, toHex, parseColor, relLuminance,
} from './lib/core.mjs';

const A = parseArgs();
const cmd = String(A._[0] ?? 'pull');
const cfg = loadConfig(A);
const API = 'https://api.figma.com/v1';

function token() {
  const t = String(str(A.token, cfg.figma?.token ?? '')).trim();
  if (!t) usage('figma.mjs <me|pull> --file <url|key>   (set figma.token in ~/.fidelity.json or FIGMA_TOKEN)');
  return t;
}

function parseRef(input) {
  const s = String(input ?? cfg.figma?.file ?? '');
  if (!s) usage('figma.mjs pull --file <figma url|file key|saved.json>');
  const m = /figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/.exec(s);
  if (!m && /figma\.com\//.test(s)) {
    usage('that URL has no file key — open the file itself and copy figma.com/design/<key>/... (the /files/ dashboard lists files but carries no key)');
  }
  const node = /[?&]node-id=([^&]+)/.exec(s)?.[1]?.replace('-', ':');
  return { key: m ? m[1] : s.split('?')[0].replace(/^\/+|\/+$/g, ''), nodeId: node };
}

async function api(p) {
  const res = await fetch(`${API}${p}`, { headers: { 'X-Figma-Token': token() } });
  if (res.status === 403) {
    summary('figma', { ok: false, status: 403 });
    console.error('  ✗ 403 — token invalid/expired, or it has no access to this file');
    process.exit(1);
  }
  if (res.status === 404) {
    summary('figma', { ok: false, status: 404 });
    console.error('  ✗ 404 — file/node not found (check the URL and that the token can see it)');
    process.exit(1);
  }
  if (!res.ok) {
    summary('figma', { ok: false, status: res.status });
    console.error(`  ✗ Figma API ${res.status}: ${(await res.text()).slice(0, 160)}`);
    process.exit(1);
  }
  return res.json();
}

/* ------------------------------------------------------------------- colors --- */

function figmaColor(c) {
  if (!c) return null;
  return { r: (c.r ?? 0) * 255, g: (c.g ?? 0) * 255, b: (c.b ?? 0) * 255, a: c.a ?? 1 };
}

function solidFill(n) {
  const f = (n.fills ?? []).find((x) => x.visible !== false && x.type === 'SOLID' && x.color);
  return f ? figmaColor(f.color) : null;
}

function boxOf(n) {
  const b = n.absoluteBoundingBox;
  if (!b) return undefined;
  return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
}

/* ------------------------------------------------------------------ walking --- */

const SKIP = new Set(['DOCUMENT', 'CANVAS']);
const KEEP = new Set([
  'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'TEXT',
  'RECTANGLE', 'ELLIPSE', 'VECTOR', 'LINE', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION',
]);

function walk(n, fn, parent = null) {
  if (n.visible === false) return;
  fn(n, parent);
  for (const c of n.children ?? []) walk(c, fn, n);
}

function findNode(root, id) {
  let found = null;
  walk(root, (n) => { if (n.id === id) found = n; });
  return found;
}

function pickFrame(file, nodeId) {
  if (nodeId) {
    const hit = findNode(file.document, nodeId);
    if (hit) return hit;
  }
  const canvases = (file.document.children ?? []).filter((c) => c.type === 'CANVAS');
  const frames = canvases.flatMap((c) => (c.children ?? []).filter((n) => ['FRAME', 'SECTION', 'COMPONENT'].includes(n.type) && n.visible !== false));
  const biggest = frames.sort((a, b) => (b.absoluteBoundingBox?.width ?? 0) - (a.absoluteBoundingBox?.width ?? 0))[0];
  if (!biggest) usage('figma.mjs pull — the file has no visible frame');
  return biggest;
}

/** A page frame is often one wrapper around the real sections: descend while it has a single child. */
function sectionsOf(frame) {
  let f = frame;
  while ((f.children ?? []).filter((c) => c.visible !== false).length === 1 && ['FRAME', 'GROUP', 'SECTION'].includes(f.children[0].type)) {
    f = f.children[0];
  }
  return (f.children ?? []).filter((c) => c.visible !== false);
}

/* -------------------------------------------------------------------- tokens --- */

function tokensOf(file, nodes) {
  const colorUse = new Map();
  const addColor = (c, { text = false, area = 0, style } = {}) => {
    if (!c) return;
    const hex = toHex(c);
    const row = colorUse.get(hex) ?? { hex, usage: 0, textUsage: 0, area: 0, styles: new Set() };
    row.usage += 1;
    if (text) row.textUsage += 1;
    row.area += area;
    if (style) row.styles.add(style);
    colorUse.set(hex, row);
  };

  const fontUse = new Map();
  const radiusUse = new Map();
  const shadowUse = new Map();

  for (const n of nodes) {
    const fill = solidFill(n);
    const styleName = n.styles?.fill ? file.styles?.[n.styles.fill]?.name : undefined;
    const area = n.absoluteBoundingBox ? n.absoluteBoundingBox.width * n.absoluteBoundingBox.height : 0;
    if (n.type === 'TEXT') addColor(fill, { text: true, area, style: styleName });
    else if (fill) addColor(fill, { area, style: styleName });

    if (n.type === 'TEXT' && n.style) {
      const s = n.style;
      const key = `${s.fontFamily}|${s.fontWeight ?? 400}|${Math.round(s.fontSize ?? 16)}`;
      const row = fontUse.get(key) ?? {
        family: s.fontFamily, weight: s.fontWeight ?? 400, size: Math.round(s.fontSize ?? 16),
        lineHeight: s.lineHeightPx ? Math.round(s.lineHeightPx) : undefined,
        letterSpacing: s.letterSpacing || 0, usage: 0,
      };
      row.usage += 1;
      fontUse.set(key, row);
    }

    if (typeof n.cornerRadius === 'number') radiusUse.set(n.cornerRadius, (radiusUse.get(n.cornerRadius) ?? 0) + 1);
    for (const r of n.rectangleCornerRadii ?? []) radiusUse.set(r, (radiusUse.get(r) ?? 0) + 1);

    for (const e of n.effects ?? []) {
      if (e.visible === false || e.type !== 'DROP_SHADOW') continue;
      const col = figmaColor(e.color);
      const key = `${e.offset?.x ?? 0}|${e.offset?.y ?? 0}|${e.radius ?? 0}|${e.spread ?? 0}|${col ? toHex(col) : 'none'}`;
      shadowUse.set(key, (shadowUse.get(key) ?? 0) + 1);
    }
  }

  const colors = [...colorUse.values()]
    .sort((a, b) => b.usage - a.usage || b.area - a.area)
    .slice(0, num(A.colors, 12))
    .map((c, i) => {
      const l = relLuminance(c.hex);
      const role = c.textUsage > 0 && l < 0.35 ? 'text' : l > 0.8 ? 'surface' : 'accent';
      const base = c.styles.size ? slug([...c.styles][0]) : `${role}-${i + 1}`;
      return { name: base, hex: c.hex, role, usage: c.usage };
    });
  const seen = new Set();
  for (const c of colors) {
    let name = c.name;
    for (let i = 2; seen.has(name); i++) name = `${c.name}-${i}`;
    c.name = name;
    seen.add(name);
  }

  const fonts = [...fontUse.values()].sort((a, b) => b.usage - a.usage);
  // Body text is the most-used face, preferring regular weights: a logo set in 700
  // would otherwise win a tie and become the body font of the whole page.
  const body = fonts.filter((f) => f.weight <= 500).sort((a, b) => b.usage - a.usage)[0] ?? fonts[0];
  const bySize = [...fonts].sort((a, b) => b.size - a.size);
  const display = bySize[0];
  const heading = bySize.find((f) => f.size < display?.size && f.size > body?.size) ?? bySize[1];
  const fontTokens = [];
  for (const [role, f] of [['body', body], ['heading', heading], ['display', display]]) {
    if (!f || fontTokens.some((x) => x.family === f.family && x.weight === f.weight && x.size === f.size)) continue;
    fontTokens.push({
      role, family: f.family, weight: f.weight, size: `${f.size}px`,
      lineHeight: `${f.lineHeight ?? Math.round(f.size * 1.4)}px`,
      letterSpacing: f.letterSpacing ? `${f.letterSpacing}px` : undefined,
      usage: f.usage,
    });
  }

  const radius = [...radiusUse.entries()]
    .filter(([value]) => value > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 6)
    .map(([value]) => ({ name: value >= 999 ? 'pill' : value <= 10 ? 'sm' : value <= 18 ? 'md' : 'lg', value: `${Math.round(value)}px` }));
  const rSeen = new Set();
  for (const r of radius) { while (rSeen.has(r.name)) r.name += 'x'; rSeen.add(r.name); }

  const shadows = [...shadowUse.entries()].slice(0, 6).map(([k, usage], i) => {
    const [x, y, blur, spread, color] = k.split('|');
    return { name: `shadow-${i + 1}`, x: +x, y: +y, blur: +blur, spread: +spread, color, usage };
  });

  return { colors, fonts: fontTokens, radius, shadows };
}

/* ---------------------------------------------------------------------- copy --- */

const ROLE_BY_NAME = [
  [/nav|header|topo/i, 'banner'],
  [/hero|banner|destaque/i, 'region'],
  [/feature|benef|recurso/i, 'region'],
  [/pric|plan|preco|preço/i, 'region'],
  [/testimonial|depoim|customer|cliente/i, 'region'],
  [/faq|pergunt/i, 'region'],
  [/cta|band|convite/i, 'region'],
  [/contact|contato|form/i, 'region'],
  [/footer|rodape|rodapé/i, 'contentinfo'],
];

const roleFor = (name) => (ROLE_BY_NAME.find(([re]) => re.test(name ?? ''))?.[1] ?? 'region');

function copyOf(nodes, frame) {
  const frameName = slug(frame.name ?? 'page');
  const texts = nodes
    .filter((n) => n.type === 'TEXT' && (n.characters ?? '').trim())
    .sort((a, b) => (a.absoluteBoundingBox?.y ?? 0) - (b.absoluteBoundingBox?.y ?? 0));
  return texts.map((n, i) => {
    const s = n.style ?? {};
    return {
      id: `c${String(i + 1).padStart(2, '0')}`,
      selector: `figma:${n.id}`,
      block: frameName,
      text: String(n.characters).replace(/\u2028/g, '\n'),
      chars: String(n.characters).length,
      font: `${s.fontFamily ?? '?'} ${s.fontWeight ?? 400} ${Math.round(s.fontSize ?? 16)}px`,
      box: boxOf(n),
    };
  });
}

/* -------------------------------------------------------------------- blocks --- */

function blocksOf(frame) {
  const sections = sectionsOf(frame);
  const designWidth = Math.round(frame.absoluteBoundingBox?.width ?? 1440);
  return sections
    .filter((n) => ['FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'INSTANCE'].includes(n.type))
    .map((n, i) => ({
      name: slug(n.name || `section-${i + 1}`),
      selector: `figma:${n.id}`,
      role: roleFor(n.name),
      measure: { [designWidth]: { box: boxOf(n) } },
      children: [],
    }));
}

/* -------------------------------------------------------------------- images --- */

async function exportImages(fileKey, nodes, outDir) {
  const assetsDir = path.join(outDir, 'images');
  ensureDir(assetsDir);
  const imageNodes = nodes.filter((n) => (n.fills ?? []).some((f) => f.type === 'IMAGE' && f.imageRef));
  const vectorNodes = nodes.filter((n) => n.type === 'VECTOR' && !(n.children ?? []).length);
  const jobs = [
    { format: 'png', scale: 2, nodes: imageNodes },
    { format: 'svg', scale: 1, nodes: vectorNodes },
  ].filter((j) => j.nodes.length);

  const manifest = { exportedAt: stamp(), files: [], failures: [] };
  for (const job of jobs) {
    const ids = job.nodes.map((n) => n.id);
    const json = await api(`/images/${fileKey}?ids=${encodeURIComponent(ids.join(','))}&format=${job.format}&scale=${job.scale}`);
    for (const n of job.nodes) {
      const url = json.images?.[n.id];
      if (!url) { manifest.failures.push({ nodeId: n.id, error: 'no image url (node may be empty)' }); continue; }
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const name = `${slug(n.name || n.id)}-${n.id.replace(':', '-')}.${job.format}`;
        fs.writeFileSync(path.join(assetsDir, name), buf);
        manifest.files.push({ nodeId: n.id, kind: job.format, file: name, bytes: buf.length, box: boxOf(n) });
        console.log(`✓ ${String(buf.length).padStart(8)} B  ${name}`);
      } catch (err) {
        manifest.failures.push({ nodeId: n.id, error: String(err).slice(0, 120) });
      }
    }
  }
  writeJson(path.join(outDir, 'images.json'), manifest);
  return manifest;
}

/* ----------------------------------------------------------------------- pull --- */

async function pull() {
  const fixturePath = str(A.fixture, '');
  const ref = fixturePath ? { key: 'fixture', nodeId: str(A.node, '') } : parseRef(A.file);
  const outDir = path.resolve(str(A.out, 'spec/figma'));
  ensureDir(outDir);

  let file;
  if (fixturePath || /\.json$/i.test(ref.key)) {
    const p = path.resolve(fixturePath || ref.key);
    file = readJsonSafe(p);
    if (!file?.document) { summary('figma', { ok: false, reason: `not a Figma file response: ${p}` }); process.exit(1); }
  } else {
    file = await api(`/files/${ref.key}?depth=${num(A.depth, 6)}`);
  }

  const frame = pickFrame(file, ref.nodeId);
  const nodes = [];
  walk(frame, (n) => { if (KEEP.has(n.type)) nodes.push(n); });

  const tokens = tokensOf(file, nodes);
  const copy = copyOf(nodes, frame);
  const blocks = blocksOf(frame);

  const tree = (function prune(n) {
    const kids = (n.children ?? []).filter((c) => c.visible !== false).map(prune);
    return {
      id: n.id, name: n.name, type: n.type, box: boxOf(n),
      text: n.type === 'TEXT' ? n.characters : undefined,
      children: kids.length ? kids : undefined,
    };
  })(frame);

  writeJson(path.join(outDir, 'tree.json'), { at: stamp(), fileKey: ref.key, frame: { id: frame.id, name: frame.name }, tree });
  writeJson(path.join(outDir, 'tokens.json'), tokens);
  writeJson(path.join(outDir, 'copy.json'), copy);
  writeJson(path.join(outDir, 'blocks.json'), blocks);

  let images;
  if (flag(A.images) && !fixturePath && ref.key !== 'fixture') {
    images = await exportImages(ref.key, nodes, outDir);
  }

  if (A.specOut) {
    const designWidth = Math.round(frame.absoluteBoundingBox?.width ?? 1440);
    const spec = {
      $schema: 'spec/v3',
      name: str(A.name, file.name ?? frame.name ?? 'Figma'),
      scope: `${frame.name} → page`,
      identity: str(A.identity, 'with-brand'),
      stack: str(A.stack, 'React + TS + plain CSS'),
      source: { figma: { fileKey: ref.key, nodeId: frame.id, fileName: file.name, frame: frame.name } },
      designWidth,
      widths: [390, 768, 1024, 1440],
      breakpoints: [],
      tags: ['clone', 'figma', 'visual'],
      tokens: { ...tokens, space: { unit: 4, steps: [] }, screens: [] },
      copy,
      blocks,
      assets: (images?.files ?? []).map((f) => ({ kind: 'image', src: `images/${f.file}`, nodeId: f.nodeId })),
      behavior: [],
      responsive: [],
      semantics: [],
      prohibitions: [],
      noExternal: true,
      // A draft has no DOM yet, so the only check that can run before the build is the
      // a11y pass (it needs no selectors). Real checks arrive with the extracted page.
      acceptance: [{ type: 'a11y', width: designWidth }],
      provenance: { generator: 'figma.mjs pull', at: stamp(), fileKey: ref.key, frame: frame.id },
      notes: 'Draft from Figma (design px). Extract the built page and merge measured values before spec.mjs build.',
    };
    const specPath = path.resolve(String(A.specOut));
    ensureDir(path.dirname(specPath));
    writeJson(specPath, spec);
    console.log(`  spec draft → ${rel(specPath, process.cwd())} (${copy.length} strings, ${tokens.colors.length} colors, ${blocks.length} blocks)`);
  }

  summary('figma-pull', {
    ok: true, file: ref.key, frame: `${frame.name} (${frame.id})`,
    nodes: nodes.length, texts: copy.length, blocks: blocks.length,
    colors: tokens.colors.length, fonts: tokens.fonts.length,
    images: images ? images.files.length : 0,
    out: rel(outDir, process.cwd()),
  });
  if (!flag(A.images)) console.log('  next: --images to export PNG/SVG, --spec-out spec/figma-spec.json for a draft spec');
}

async function me() {
  const u = await api('/me');
  summary('figma-me', { ok: true, handle: u.handle, email: u.email, id: u.id });
}

switch (cmd) {
  case 'me': await me(); break;
  case 'pull': await pull(); break;
  default: usage('figma.mjs <me|pull> --file <figma url|key|saved.json> [--out spec/figma] [--images] [--spec-out path]');
}
