#!/usr/bin/env node
// ASSETS — pin, download and process the reference's assets; build metric-compatible
// font fallbacks; and generate internal SVG placeholders (zero external dependency).
//
//   node assets.mjs fetch   --spec spec/spec.json [--dir .] [--out spec/sources]
//   node assets.mjs fonts   --spec spec/spec.json [--url http://localhost:3000] [--write]
//   node assets.mjs fonts-local --spec spec/spec.json [--out assets/fonts] [--families "Inter:400,600;Lora"]
//                             # downloads woff2 + writes a self-hosted fonts.css (no hotlink, no key)
//   node assets.mjs search  --query "inter"     # Google Fonts metadata (needs GOOGLE_FONTS_API_KEY)
//   node assets.mjs placeholder --kind logo|pattern|hero-art|avatar --out assets/logo.svg [--seed x] [--palette "#111,#eee"]
//   node assets.mjs inventory --assets import/assets.json     # ranking of what to pin first
import path from 'node:path';
import fs from 'node:fs';
import {
  parseArgs, num, str, flag, readJsonSafe, writeJson, writeText, ensureDir, sha256, humanBytes,
  rel, usage, summary, slug, stamp, loadConfig,
} from './lib/core.mjs';
import { withBrowser, newPage, measureFontMetrics } from './lib/browser.mjs';

const A = parseArgs();
const cmd = String(A._[0] ?? 'fetch');

/* --------------------------------------------------------------- fetching --- */

async function fetchAssets() {
  const specPath = path.resolve(str(A.spec, 'spec/spec.json'));
  const spec = readJsonSafe(specPath);
  if (!spec) usage('assets.mjs fetch --spec spec/spec.json [--dir .] [--out spec/sources]');
  const projectDir = path.resolve(str(A.dir, '.'));
  const sourcesDir = path.resolve(str(A.out, 'spec/sources'));
  ensureDir(sourcesDir);
  const manifest = { generatedAt: stamp(), spec: rel(specPath, process.cwd()), files: [] };
  const failures = [];
  for (const asset of spec.assets ?? []) {
    if (asset.substituted) { manifest.files.push({ ...asset, skipped: 'substituted (de-branded)' }); continue; }
    if (!asset.url || /^data:/i.test(asset.url)) { manifest.files.push({ ...asset, skipped: 'inline/data url' }); continue; }
    const dest = path.resolve(projectDir, asset.dest ?? `public/assets/${slug(path.basename(asset.url))}`);
    ensureDir(path.dirname(dest));
    try {
      const res = await fetch(asset.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buf);
      manifest.files.push({
        kind: asset.kind, url: asset.url, path: rel(dest, projectDir), bytes: buf.length,
        sha256: sha256(buf), contentType: res.headers.get('content-type') ?? '', fetchedAt: stamp(),
      });
      console.log(`✓ ${humanBytes(buf.length).padStart(8)}  ${rel(dest, projectDir)}`);
    } catch (err) {
      failures.push({ url: asset.url, error: String(err).slice(0, 140) });
      console.error(`✗ ${asset.url} — ${String(err).slice(0, 120)}`);
    }
  }
  writeJson(path.join(sourcesDir, 'manifest.json'), manifest);
  summary('assets-fetch', { files: manifest.files.filter((f) => f.sha256).length, skipped: manifest.files.filter((f) => f.skipped).length, failed: failures.length, manifest: rel(path.join(sourcesDir, 'manifest.json'), process.cwd()) });
  if (failures.length) console.log('  never substitute a "similar" asset — either fetch it or mark it substituted in the spec.');
  process.exit(failures.length ? 1 : 0);
}

/** Ranking of what to pin first (biggest visual weight per byte). */
function inventoryAssets() {
  const p = path.resolve(str(A.assets, 'import/assets.json'));
  const a = readJsonSafe(p);
  if (!a) usage('assets.mjs inventory --assets import/assets.json');
  const rows = (a.images ?? []).map((i) => ({ url: i.url, kind: 'image', w: i.w, h: i.h, area: i.w * i.h, alt: i.alt }))
    .concat((a.videos ?? []).map((v) => ({ url: v.url, kind: 'video', w: v.w, h: v.h, area: (v.w || 1280) * (v.h || 720), duration: v.duration })))
    .sort((x, y) => y.area - x.area);
  console.log(`# ${rows.length} assets · pinning order (visual weight) — do not substitute, do not re-encode unless specified`);
  rows.slice(0, num(A.max, 25)).forEach((r, i) => console.log(`${String(i + 1).padStart(3)}  ${r.kind.padEnd(5)} ${String(r.w ?? '?').padStart(5)}×${String(r.h ?? '?').padEnd(5)} ${String(Math.round(r.area / 1000)).padStart(7)}k px  ${r.url.slice(0, 110)}`));
  if (a.origins?.length) console.log(`# origins: ${a.origins.join(', ')}`);
  summary('assets-inventory', { count: rows.length, videos: (a.videos ?? []).length, fonts: (a.fonts ?? []).length, styles: (a.styles ?? []).length });
}

/* ----------------------------------------------------------------- fonts --- */

async function fonts() {
  const specPath = path.resolve(str(A.spec, 'spec/spec.json'));
  const spec = readJsonSafe(specPath);
  if (!spec) usage('assets.mjs fonts --spec spec/spec.json [--url http://localhost:3000] [--write]');
  const families = (spec.tokens?.fonts ?? []).map((f) => f.family).filter(Boolean);
  const candidates = (str(A.candidates, '') || 'Inter,IBM Plex Sans,Manrope,Source Sans 3,Noto Sans,Open Sans,Roboto,Lato,Montserrat,Poppins,Work Sans,System UI,Arial,Helvetica,Segoe UI').split(',').map((s) => s.trim());
  const out = { measuredAt: stamp(), probeText: 'Hamburgefonstiv ABC xyz 0123456789', fonts: [] };
  await withBrowser(async (browser) => {
    const made = await newPage(browser, { width: 1366, height: 900 });
    await made.page.goto(str(A.url, spec.source?.url || 'about:blank'), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
    const metrics = await measureFontMetrics(made.page, [...new Set([...families, ...candidates])]);
    const byName = Object.fromEntries(metrics.map((m) => [m.family, m]));
    for (const f of spec.tokens?.fonts ?? []) {
      const target = byName[f.family];
      const hotlinked = (f.src ?? []).some((u) => /^https?:/i.test(u));
      let best = null;
      for (const c of candidates) {
        const cand = byName[c];
        if (!cand || cand.width === 0 || c === f.family) continue;
        const sizeAdjust = target?.width ? cand.width / target.width : 1; // >1 → candidate is wider
        const ascentOverride = target?.ascent ? (target.ascent / 100) * sizeAdjust : null;
        const descentOverride = target?.descent ? (target.descent / 100) * sizeAdjust : null;
        const lineGapOverride = target ? Math.max(0, (target.ascent + target.descent) / 100 * sizeAdjust - (cand.ascent + cand.descent) / 100) : null;
        const err = target ? Math.abs(cand.width * sizeAdjust - target.width) / target.width : 1;
        const score = err; // advance-width match (dominant for line breaking)
        if (!best || score < best.score) best = { family: c, score, sizeAdjust, ascentOverride, descentOverride, lineGapOverride, width: cand.width, ascent: cand.ascent, descent: cand.descent };
      }
      out.fonts.push({
        role: f.role, family: f.family, weight: f.weight, hotlinked,
        target: target ? { width: target.width, ascent: target.ascent, descent: target.descent, spaceAdv: target.spaceAdv } : null,
        fallback: best ? {
          family: best.family, metricMatch: `${(100 * (1 - best.score)).toFixed(1)}%`,
          sizeAdjust: `${(best.sizeAdjust * 100).toFixed(2)}%`,
          ascentOverride: best.ascentOverride ? `${best.ascentOverride.toFixed(2)}%` : undefined,
          descentOverride: best.descentOverride ? `${best.descentOverride.toFixed(2)}%` : undefined,
          lineGapOverride: best.lineGapOverride ? `${best.lineGapOverride.toFixed(2)}%` : undefined,
        } : null,
        note: 'override convention: metric% = (targetMetric/100px) × sizeAdjust (same convention as next/font)',
      });
    }
  });
  writeJson(path.resolve(str(A.out, 'spec/fonts.json')), out);
  if (flag(A.write) && spec) {
    for (const f of spec.tokens?.fonts ?? []) {
      const m = out.fonts.find((x) => x.role === f.role);
      if (m?.fallback) f.fallback = m.fallback;
    }
    writeJson(specPath, spec);
  }
  summary('assets-fonts', { fonts: out.fonts.length, hotlinked: out.fonts.filter((f) => f.hotlinked).length, written: flag(A.write), out: rel(path.resolve('spec/fonts.json'), process.cwd()) });
  for (const f of out.fonts) {
    if (f.hotlinked && f.fallback) console.log(`  ${f.role}: "${f.family}" → fallback "${f.fallback.family}" (match ${f.fallback.metricMatch}, size-adjust ${f.fallback.sizeAdjust})`);
    else if (f.hotlinked) console.log(`  ${f.role}: "${f.family}" hotlinked, no local candidate measured (is the family installed?)`);
  }
}

/* --------------------------------------------------------- fonts (local) --- */

const GOOGLE_CSS = 'https://fonts.googleapis.com/css2';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function wantedFonts(spec) {
  const explicit = str(A.families, '');
  if (explicit) {
    return explicit.split(';').map((entry) => {
      const [family, weights] = entry.split(':');
      return { family: family.trim(), weights: weights ? weights.split(',').map((w) => w.trim()).filter(Boolean) : [] };
    }).filter((f) => f.family);
  }
  const byFamily = new Map();
  for (const f of spec.tokens?.fonts ?? []) {
    if (!f?.family) continue;
    if (!byFamily.has(f.family)) byFamily.set(f.family, new Set());
    if (f.weight) byFamily.get(f.family).add(String(f.weight));
  }
  return [...byFamily].map(([family, weights]) => ({ family, weights: [...weights].sort((a, b) => Number(a) - Number(b)) }));
}

function googleCssUrl(entries) {
  const parts = entries.map(({ family, weights }) => {
    const name = family.trim().replace(/\s+/g, '+');
    const w = [...new Set(weights)].sort((a, b) => Number(a) - Number(b));
    return `family=${name}${w.length ? `:wght@${w.join(';')}` : ''}`;
  });
  return `${GOOGLE_CSS}?${parts.join('&')}&display=swap`;
}

/** Split a CSS2 response into @font-face records, keeping the subset comment above each. */
function parseFaces(css) {
  const faces = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[1];
    const before = css.slice(Math.max(0, m.index - 400), m.index);
    const comments = [...before.matchAll(/\/\*\s*([a-z0-9-]+)\s*\*\//g)].map((c) => c[1]);
    const family = /font-family:\s*'([^']+)'/.exec(body)?.[1] ?? /font-family:\s*([^;]+);/.exec(body)?.[1]?.trim();
    const weight = /font-weight:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '400';
    const style = /font-style:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? 'normal';
    const url = /url\((https:[^)]+\.woff2)\)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim();
    if (family && url) faces.push({ family, weight, style, url, range, subset: comments.at(-1) ?? '' });
  }
  return faces;
}

async function downloadFonts() {
  const specPath = path.resolve(str(A.spec, 'spec/spec.json'));
  const spec = readJsonSafe(specPath) ?? {};
  const entries = wantedFonts(spec);
  if (!entries.length) usage('assets.mjs fonts-local --spec spec/spec.json [--families "Inter:400,600;Lora"] [--out assets/fonts]');
  const outDir = path.resolve(str(A.out, 'assets/fonts'));
  ensureDir(outDir);

  const cssUrl = googleCssUrl(entries);
  const res = await fetch(cssUrl, { headers: { 'user-agent': CHROME_UA } });
  if (!res.ok) {
    summary('assets-fonts-local', { ok: false, status: res.status, families: entries.map((e) => e.family) });
    console.error('  ✗ Google Fonts rejected the family/weight list — check names with: assets.mjs search --query "<name>"');
    process.exit(1);
  }
  const facesAll = parseFaces(await res.text());
  // A PT-BR/EN page needs two subsets; shipping Cyrillic/Greek/math quadruples the bytes.
  const subsetArg = str(A.subsets, 'latin,latin-ext');
  const wantedSubsets = subsetArg === 'all' ? null : new Set(subsetArg.split(',').map((s) => s.trim()).filter(Boolean));
  const faces = facesAll.filter((f) => !wantedSubsets || !f.subset || wantedSubsets.has(f.subset));
  const skippedFaces = facesAll.length - faces.length;
  if (!faces.length) {
    summary('assets-fonts-local', { ok: false, reason: `no faces in subsets ${subsetArg} (available: ${[...new Set(facesAll.map((f) => f.subset))].join(', ')})` });
    process.exit(1);
  }

  const used = new Map(); // name → face (dedupe by family+weight+style+subset)
  const failures = [];
  let total = 0;
  for (const face of faces) {
    const key = `${slug(face.family)}-${face.weight.replace(/\s+/g, '-')}-${face.style}-${face.subset || 'file'}`;
    let name = `${key}.woff2`;
    let n = 1;
    while (used.has(name) && used.get(name).url !== face.url) name = `${key}-${++n}.woff2`;
    if (used.has(name)) { face.name = name; continue; }
    try {
      const r = await fetch(face.url, { headers: { 'user-agent': CHROME_UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('not a woff2 file');
      fs.writeFileSync(path.join(outDir, name), buf);
      total += buf.length;
      used.set(name, { ...face, name, bytes: buf.length, sha256: sha256(buf) });
      console.log(`✓ ${humanBytes(buf.length).padStart(8)}  ${name}`);
    } catch (err) {
      failures.push({ family: face.family, weight: face.weight, url: face.url, error: String(err).slice(0, 120) });
      console.error(`✗ ${face.family} ${face.weight} ${face.subset}: ${String(err).slice(0, 110)}`);
    }
  }

  const files = [...used.values()];
  const blocks = files.map((f) => `@font-face {
  font-family: '${f.family}';
  font-style: ${f.style};
  font-weight: ${f.weight};
  font-display: swap;
  src: url('./${f.name}') format('woff2');
${f.range ? `  unicode-range: ${f.range};\n` : ''}}`);
  writeText(path.join(outDir, 'fonts.css'), `/* Self-hosted Google Fonts — generated ${new Date().toISOString().slice(0, 10)} by assets.mjs fonts-local.
   Source: ${cssUrl}
   Keep the font licence files next to the woff2 files (OFL-1.1 / Apache-2.0 / UFL). */
${blocks.join('\n\n')}\n`);

  const manifest = {
    generatedAt: stamp(), source: cssUrl, out: rel(outDir, process.cwd()),
    families: entries.map((e) => e.family),
    subsets: subsetArg,
    faces: files.length, bytes: total,
    files: files.map((f) => ({ family: f.family, weight: f.weight, style: f.style, subset: f.subset, file: f.name, bytes: f.bytes, sha256: f.sha256, url: f.url })),
    license: 'Google Fonts are open-source (OFL-1.1 / Apache-2.0 / UFL). Ship the licence text with the files.',
    install: `link ${rel(path.join(outDir, 'fonts.css'), process.cwd())} and remove the Google Fonts <link>`,
    failures,
  };
  writeJson(path.join(outDir, 'fonts.json'), manifest);
  summary('assets-fonts-local', { ok: failures.length === 0, faces: files.length, skipped: skippedFaces, subsets: subsetArg, families: entries.length, bytes: total, out: rel(outDir, process.cwd()) });
  if (failures.length) process.exit(1);
}

/** Google Fonts metadata (key from config/env; never written to disk by this script). */
async function searchFonts() {
  const query = String(str(A.query, str(A.q, ''))).trim();
  const cfg = loadConfig(A);
  const key = String(str(A.key, cfg.googleFonts?.key ?? '')).trim();
  if (!key) usage('assets.mjs search --query "inter"   (set googleFonts.key in ~/.fidelity.json, or GOOGLE_FONTS_API_KEY)');
  const url = `https://www.googleapis.com/webfonts/v1/webfonts?key=${encodeURIComponent(key)}&sort=popularity&fields=items(family,category,variants,subsets)`;
  const res = await fetch(url);
  if (!res.ok) {
    summary('assets-search', { ok: false, status: res.status });
    console.error(`  ✗ metadata API returned ${res.status} — key invalid, restricted, or the Webfonts API is not enabled`);
    process.exit(1);
  }
  const json = await res.json();
  const rows = (json.items ?? []).filter((it) => !query || it.family.toLowerCase().includes(query.toLowerCase()));
  console.log(`# ${rows.length} famil${rows.length === 1 ? 'y' : 'ies'}${query ? ` matching "${query}"` : ''} (by popularity)`);
  for (const it of rows.slice(0, num(A.max, 20))) {
    const weights = it.variants.filter((v) => /^(regular|\d{3})$/.test(v)).map((v) => (v === 'regular' ? '400' : v)).slice(0, 12);
    console.log(`  ${it.family.padEnd(28)} ${String(it.category).padEnd(11)} ${weights.join(',')}`);
  }
  summary('assets-search', { ok: true, query, matches: rows.length, api: 'webfonts/v1' });
}

/* ----------------------------------------------------------- placeholders --- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hashSeed = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

/** Deterministic internal SVG art: no external assets, no licences, no 404s. */
function placeholder() {
  const kind = str(A.kind, 'logo');
  const seedStr = str(A.seed, `fidelity-${kind}`);
  const rnd = mulberry32(hashSeed(seedStr));
  const palette = (str(A.palette, '') || '#0f172a,#334155,#94a3b8,#e2e8f0').split(',').map((s) => s.trim());
  const pick = () => palette[Math.floor(rnd() * palette.length)];
  const size = num(A.size, kind === 'avatar' ? 96 : kind === 'pattern' ? 160 : 480);
  const label = str(A.label, '');
  let svg = '';
  if (kind === 'logo') {
    const cx = size / 2, cy = size / 2, r = size * 0.34;
    const sides = 3 + Math.floor(rnd() * 4);
    const pts = Array.from({ length: sides }, (_, i) => {
      const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
      return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label || 'logo'}">
  <rect width="${size}" height="${size}" rx="${(size * 0.18).toFixed(0)}" fill="${palette[0]}"/>
  <polygon points="${pts}" fill="${pick()}" opacity="0.92"/>
  <circle cx="${cx}" cy="${cy}" r="${(r * 0.42).toFixed(1)}" fill="${pick()}"/>
</svg>`;
  } else if (kind === 'pattern') {
    const step = 20 + Math.floor(rnd() * 20);
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="pattern">
  <defs><pattern id="p" width="${step}" height="${step}" patternUnits="userSpaceOnUse" patternTransform="rotate(${Math.floor(rnd() * 90)})">
    <rect width="${step}" height="${step}" fill="${palette[0]}"/>
    <circle cx="${step / 2}" cy="${step / 2}" r="${step * 0.18}" fill="${pick()}" opacity="0.6"/>
    <path d="M0 ${step} L${step} 0" stroke="${pick()}" stroke-width="1" opacity="0.35"/>
  </pattern></defs>
  <rect width="${size}" height="${size}" fill="url(#p)"/>
</svg>`;
  } else if (kind === 'avatar') {
    const initials = (label || seedStr).split(/\s+/).map((w) => w[0]?.toUpperCase() ?? '').join('').slice(0, 2);
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label || initials}">
  <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${pick()}"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="${size * 0.4}" fill="${palette[0]}">${initials}</text>
</svg>`;
  } else {
    const w = size, h = Math.round(size * 0.6);
    const blobs = Array.from({ length: 4 }, (_, i) => {
      const bx = rnd() * w, by = rnd() * h, br = (0.15 + rnd() * 0.35) * w;
      return `<circle cx="${bx.toFixed(0)}" cy="${by.toFixed(0)}" r="${br.toFixed(0)}" fill="${pick()}" opacity="0.55"/>`;
    }).join('\n  ');
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="art">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${palette[0]}"/><stop offset="100%" stop-color="${pick()}"/>
  </linearGradient>
  <filter id="b"><feGaussianBlur stdDeviation="${(w * 0.06).toFixed(0)}"/></filter></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <g filter="url(#b)">
  ${blobs}
  </g>
  <rect x="${(w * 0.08).toFixed(0)}" y="${(h * 0.34).toFixed(0)}" width="${(w * 0.84).toFixed(0)}" height="${(h * 0.32).toFixed(0)}" rx="${(h * 0.06).toFixed(0)}" fill="${palette[0]}" opacity="0.18"/>
</svg>`;
  }
  const out = path.resolve(str(A.out, `assets/${kind}.svg`));
  writeText(out, svg + '\n');
  summary('assets-placeholder', { kind, out: rel(out, process.cwd()), seed: seedStr, palette: palette.length, bytes: svg.length });
}

switch (cmd) {
  case 'fetch': await fetchAssets(); break;
  case 'fonts': await fonts(); break;
  case 'fonts-local': await downloadFonts(); break;
  case 'search': await searchFonts(); break;
  case 'placeholder': placeholder(); break;
  case 'inventory': inventoryAssets(); break;
  default: usage('assets.mjs <fetch|fonts|fonts-local|search|placeholder|inventory> [options]');
}
