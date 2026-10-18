// lib/core.mjs — shared CLI/config/color/fs/io helpers for every fidelity script.
// Design rules:
//   * Nothing here touches the network or a browser.
//   * Every script prints a MACHINE-READABLE one-liner on stdout and rich detail in
//     files; stdout stays cheap so the agent never has to read a big artifact.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SKILL_DIR = path.dirname(SCRIPTS_DIR);
export const RULES_DIR = path.join(SKILL_DIR, 'rules');
export const REFS_DIR = path.join(SKILL_DIR, 'references');

export const PKG = readJsonSafe(path.join(SCRIPTS_DIR, 'package.json')) ?? { version: '0.0.0' };

/* ------------------------------------------------------------------ args --- */

/** Parse `--key value`, `--key=value`, `--flag`, `-f`. Repeated keys become arrays. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  const push = (key, val) => {
    const k = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    if (out[k] === undefined) out[k] = val;
    else if (Array.isArray(out[k])) out[k].push(val);
    else out[k] = [out[k], val];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) { push(a.slice(2, eq), a.slice(eq + 1)); continue; }
      const next = argv[i + 1];
      push(a.slice(2), next !== undefined && !next.startsWith('--') ? (i++, next) : true);
    } else if (/^-[A-Za-z]/.test(a)) {
      for (const ch of a.slice(1)) push(ch, true);
    } else out._.push(a);
  }
  return out;
}

/** Always an array (handles undefined / scalar / repeated). */
export const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/** Boolean flag: absent → false, `--x` → true, `--x=false` → false. */
export const flag = (v) => v === true || v === 'true' || v === '' || (v !== undefined && v !== 'false' && v !== false);
export const num = (v, d) => (v === undefined || v === '' || v === true ? d : Number(v));
export const str = (v, d) => (typeof v === 'string' && v.length ? v : d);
export const csv = (v, map = Number) =>
  (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean).map(map) : []);

/** `key:selector;;key2:selector2` — `;;` because selectors legitimately contain commas. */
export function parsePairs(spec, fallbackSep = ';;') {
  return arr(spec)
    .flatMap((s) => String(s).split(fallbackSep))
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(':');
      return i < 0 ? null : { key: entry.slice(0, i).trim(), selector: entry.slice(i + 1).trim() };
    })
    .filter(Boolean);
}

/* ---------------------------------------------------------------- config --- */

export function defaultConfig() {
  return {
    projectsRoot: process.env.FIDELITY_PROJECTS || path.join(os.homedir(), 'Desktop', 'PROJETOS'),
    widths: csv(process.env.FIDELITY_WIDTHS) .length
      ? csv(process.env.FIDELITY_WIDTHS)
      : [320, 390, 700, 701, 863, 1024, 1366, 1920, 2035],
    height: 900,
    scale: 1,
    settleMs: 500,
    workers: Number(process.env.FIDELITY_WORKERS || 4),
    timeoutMs: 30000,
    scrollThrough: true,
    thresholdPct: 3,
    odiffThreshold: 0.1,
    retries: 2,
    judge: {
      url: process.env.FIDELITY_JUDGE_URL || '',
      key: process.env.FIDELITY_JUDGE_KEY || '',
      model: process.env.FIDELITY_JUDGE_MODEL || '',
    },
    googleFonts: {
      key: process.env.GOOGLE_FONTS_API_KEY || '',
    },
    figma: {
      token: process.env.FIGMA_TOKEN || process.env.FIDELITY_FIGMA_TOKEN || '',
      file: process.env.FIDELITY_FIGMA_FILE || '',
    },
    budgets: { jsKb: 320, cssKb: 140, imgKb: 1600, requests: 70, lcpMs: 2500, cls: 0.1 },
  };
}

/** defaults < ~/.fidelity.json < ./.fidelity.json (or --config) < FIDELITY_* env < cli. */
export function loadConfig(cli = {}, { cwd = process.cwd() } = {}) {
  const deep = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deep(a?.[k] ?? {}, v) : v;
    }
    return out;
  };
  let cfg = defaultConfig();
  for (const p of [
    path.join(os.homedir(), '.fidelity.json'),
    str(cli.config, path.join(cwd, '.fidelity.json')),
  ]) {
    if (p && fs.existsSync(p)) cfg = deep(cfg, readJsonSafe(p));
  }
  const cliSub = { ...cli };
  delete cliSub._;
  if (cliSub.widths) cliSub.widths = csv(cliSub.widths);
  else delete cliSub.widths;
  for (const k of ['height', 'settleMs', 'workers', 'scale', 'timeoutMs', 'retries', 'thresholdPct', 'odiffThreshold']) {
    if (cliSub[k] !== undefined) cliSub[k] = num(cliSub[k], cfg[k]);
  }
  return deep(cfg, cliSub);
}

/** Where a project build lives (create-on-demand). Never a temp dir. */
export function projectDir(name, cfg = defaultConfig(), { cwd = process.cwd() } = {}) {
  if (!name) return cwd;
  const abs = path.isAbsolute(name) ? name : path.join(cfg.projectsRoot, slug(name));
  ensureDir(abs);
  return abs;
}

/* ------------------------------------------------------------------- fs --- */

// Windows editors (Notepad, PowerShell Set-Content) prepend a UTF-8 BOM; JSON.parse
// and every `startsWith('{')` check then fail on a file that looks perfectly fine.
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
export function readJsonSafe(p) {
  try { return JSON.parse(stripBom(fs.readFileSync(p, 'utf8'))); } catch { return undefined; }
}
export function readJson(p) {
  const v = readJsonSafe(p);
  if (v === undefined) fail(`cannot read JSON: ${p}`);
  return v;
}
export function writeJson(p, obj, { pretty = 1 } = {}) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, pretty) + '\n');
  return p;
}
export function readNdjson(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return undefined; }
  }).filter(Boolean);
}
export function writeNdjson(p, rows) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return p;
}
export function writeText(p, text) { ensureDir(path.dirname(p)); fs.writeFileSync(p, text); return p; }
export function readText(p) { return fs.existsSync(p) ? stripBom(fs.readFileSync(p, 'utf8')) : ''; }
export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
export function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); return p; }
export function exists(p) { return fs.existsSync(p); }
export function listFiles(dir, filter = () => true) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(dir, d.name)).filter(filter);
}
export function walk(dir, filter = () => true, out = []) {
  if (!exists(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== 'node_modules' && d.name !== '.git') walk(p, filter, out); }
    else if (filter(p)) out.push(p);
  }
  return out;
}
export function sha256(input) {
  const h = crypto.createHash('sha256');
  h.update(Buffer.isBuffer(input) ? input : fs.existsSync(String(input)) ? fs.readFileSync(String(input)) : String(input));
  return h.digest('hex');
}
export function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  for (const [u, d] of [['B', 1], ['KB', 1024], ['MB', 1048576]]) if (n < d * 1024 || u === 'MB') return `${(n / d).toFixed(u === 'B' ? 0 : 1)}${u}`;
}
export function rel(p, from = process.cwd()) { return path.relative(from, p).split(path.sep).join('/'); }
export function slug(s) { return String(s).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'; }
export function stamp(d = new Date()) { return d.toISOString().replace(/\.\d+Z$/, 'Z'); }
export function dayStamp(d = new Date()) { return d.toISOString().slice(0, 10); }

/* ----------------------------------------------------------------- color --- */

const NAMED = {
  transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1],
  red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1], gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1], silver: [192, 192, 192, 1], currentcolor: null,
};

/** Parse `rgb()/rgba()/#rgb/#rrggbb/#rrggbbaa/named` → {r,g,b,a} (0..255, 0..1). */
export function parseColor(str) {
  if (str == null) return null;
  const s = String(str).trim().toLowerCase();
  if (NAMED[s] === null) return null;
  if (NAMED[s]) { const [r, g, b, a] = NAMED[s]; return { r, g, b, a }; }
  let m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1 };
  }
  m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const h = m[1];
    const ex = (i, n = 1) => parseInt(h.slice(i, i + n).repeat(2 / n), 16);
    if (h.length === 3 || h.length === 4) return { r: ex(0), g: ex(1), b: ex(2), a: h.length === 4 ? ex(3) : 1 };
    if (h.length === 6 || h.length === 8) return { r: ex(0, 2), g: ex(2, 2), b: ex(4, 2), a: h.length === 8 ? ex(6, 2) / 255 : 1 };
  }
  return null;
}
export function toHex(c) {
  if (!c) return 'none';
  return '#' + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
/** Flatten rgba over a background (needed to compare computed colors on paint). */
export function flatten(c, bg = { r: 255, g: 255, b: 255 }) {
  if (!c || c.a >= 1) return c;
  const a = c.a ?? 1;
  return { r: c.r * a + bg.r * (1 - a), g: c.g * a + bg.g * (1 - a), b: c.b * a + bg.b * (1 - a), a: 1 };
}
const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export function relLuminance(c) {
  const col = typeof c === 'string' ? parseColor(c) : c;
  if (!col) return 0;
  const f = flatten(col);
  return 0.2126 * lin(f.r) + 0.7152 * lin(f.g) + 0.0722 * lin(f.b);
}
/** Accepts parsed colours or colour strings (`#rrggbb`, `rgb()`, …). */
export function contrast(a, b) {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (!ca || !cb) return NaN;
  const l1 = relLuminance(ca), l2 = relLuminance(cb);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}
export function wcagLevel(ratio, large = false) {
  const aa = large ? 3 : 4.5, aaa = large ? 4.5 : 7;
  return ratio >= aaa ? 'AAA' : ratio >= aa ? 'AA' : ratio >= 3 ? 'AA-large' : 'fail';
}
/** Redmean perceptual distance (0..765); ~0 = identical, >30 = visibly different. */
export function colorDistance(a, b) {
  if (!a || !b) return 0;
  const rm = (a.r + b.r) / 2, dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const round = (v, d = 3) => +Number(v).toFixed(d);
export const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------- out --- */

export function log(...a) { console.log(...a); }
export function warn(...a) { console.error(...a); }
export function fail(msg, code = 2) { console.error(`✗ ${msg}`); process.exit(code); }
export function usage(text) { console.error(text.trim()); process.exit(2); }
export function banner(name, detail) { console.log(`▶ ${name}${detail ? ` — ${detail}` : ''}`); }
export function summary(name, data) { console.log(`${name} ${JSON.stringify(data)}`); }
