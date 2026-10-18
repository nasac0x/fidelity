// lib/img.mjs — image primitives: load/save, annotated contact sheets, grid diffing
// and clustering. Pure local work (jimp + pixelmatch + odiff), never the network.
//
// Everything here exists so the agent can *see less*: a diff becomes numbers
// (clusters + mean colors) and N region images become ONE annotated contact sheet.
import { Jimp, loadFont, measureText, HorizontalAlign, VerticalAlign } from 'jimp';
import { PNGColorType } from 'jimp';
import pixelmatch from 'pixelmatch';
import path from 'node:path';
import fs from 'node:fs';
import { ensureDir, colorDistance, toHex, parseColor, clamp, round } from './core.mjs';

const FONT_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
  'node_modules/@jimp/plugin-print/dist/fonts/open-sans',
);
const fonts = {};
/** Cached bitmap font: 'w16' | 'b16' | 'w32' | 'b8' ... */
export async function getFont(name = 'w16') {
  if (fonts[name]) return fonts[name];
  const size = Number(name.slice(1)) || 16;
  const color = name.startsWith('b') ? 'black' : 'white';
  const f = path.join(FONT_DIR, `open-sans-${size}-${color}`, `open-sans-${size}-${color}.fnt`);
  if (!fs.existsSync(f)) throw new Error(`font not found: ${f}`);
  fonts[name] = await loadFont(f);
  return fonts[name];
}

/* ------------------------------------------------------------- load/save --- */

/** → {img, w, h, data} or null when unreadable (some site PNGs have odd chunks). */
export async function loadImage(p) {
  try {
    const img = await Jimp.read(p);
    return { img, w: img.bitmap.width, h: img.bitmap.height, data: img.bitmap.data };
  } catch (err) {
    return { error: String(err).slice(0, 160) };
  }
}
export async function savePng(img, p) { ensureDir(path.dirname(p)); await img.write(p); return p; }
export function blank(w, h, color = 0xffffffff) {
  const W = Math.round(w), H = Math.round(h);
  // Fail with a sentence, not `ERR_OUT_OF_RANGE` from deep inside the PNG encoder.
  if (!Number.isFinite(W) || !Number.isFinite(H) || W < 1 || H < 1 || W > 20000 || H > 20000) {
    throw new Error(`blank(): refusing a ${w}×${h} canvas (expected 1..20000 px per side)`);
  }
  if (!Number.isInteger(color) || color < 0 || color > 0xffffffff) {
    throw new Error(`blank(): colour ${color} is not a uint32 — RGBA literals take 8 hex digits (0xRRGGBBAA)`);
  }
  return new Jimp({ width: W, height: H, color });
}
export const rgba = (r, g, b, a = 255) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0;

export function drawLabel(img, text, x, y, { color = 0xffffffff, bg = 0x000000ff, font = 'w16', pad = 3 } = {}) {
  const f = fonts[font];
  if (!f) return;
  const w = measureText(f, text);
  const h = (f.common?.lineHeight ?? 18);
  if (bg !== null) img.scan(x - pad, y - pad, w + pad * 2, h + pad, function (__ix, __iy, idx) {
    this.bitmap.data[idx] = (bg >> 24) & 255;
    this.bitmap.data[idx + 1] = (bg >> 16) & 255;
    this.bitmap.data[idx + 2] = (bg >> 8) & 255;
    this.bitmap.data[idx + 3] = 255;
  });
  img.print({ font: f, x, y, text, align: HorizontalAlign.LEFT, vAlign: VerticalAlign.TOP, color });
}

export function drawRect(img, rect, color = 0xff3b30ff, thickness = 2) {
  const { x, y, w, h } = rect;
  img.scan(x, y, Math.max(1, w), thickness, function (__x, __y, idx) { setPx(this.bitmap.data, idx, color); });
  img.scan(x, y + h - thickness, Math.max(1, w), thickness, function (__x, __y, idx) { setPx(this.bitmap.data, idx, color); });
  img.scan(x, y, thickness, Math.max(1, h), function (__x, __y, idx) { setPx(this.bitmap.data, idx, color); });
  img.scan(x + w - thickness, y, thickness, Math.max(1, h), function (__x, __y, idx) { setPx(this.bitmap.data, idx, color); });
}
function setPx(data, idx, color) {
  data[idx] = (color >> 24) & 255; data[idx + 1] = (color >> 16) & 255;
  data[idx + 2] = (color >> 8) & 255; data[idx + 3] = 255;
}

export function getPixel(img, x, y) {
  const c = img.getPixelColor(clamp(x, 0, img.bitmap.width - 1), clamp(y, 0, img.bitmap.height - 1));
  return { r: (c >> 24) & 255, g: (c >> 16) & 255, b: (c >> 8) & 255, a: (c & 255) / 255 };
}

/** Scale an image so its width fits `maxW` (label rows add height outside this). */
export function fitWidth(img, maxW) {
  if (img.bitmap.width <= maxW) return img;
  img.resize({ w: maxW, h: Math.round((img.bitmap.height * maxW) / img.bitmap.width) });
  return img;
}
/** Scale to fit a box (never upscales): keeps tall phone captures readable in a sheet. */
export function fitBox(img, maxW, maxH) {
  const { width: w, height: h } = img.bitmap;
  const scale = Math.min(1, maxW / w, maxH / h);
  if (scale >= 1) return img;
  img.resize({ w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) });
  return img;
}
/** Solid rectangle (drawRect with full thickness is a border, not a fill). */
export function fillRect(img, { x, y, w, h }, color = 0x000000ff) {
  img.scan(x, y, Math.max(1, w), Math.max(1, h), function (__x, __y, idx) { setPx(this.bitmap.data, idx, color); });
}

/**
 * Contact sheet: ONE image for N comparisons. Each tile becomes a column-ish block:
 *   [label row]
 *   ref | build | diff        (stacked vertically inside the tile)
 * Tiles are laid out in a grid of `cols`. Returns the path + a machine-readable index
 * so the agent can zoom into the one tile that matters instead of opening every PNG.
 */
export async function contactSheet({ tiles, out, cols = 2, tileWidth = 620, maxImgHeight = 560, gap = 12, bg = 0x1b1b1fff, stackLabels = true }) {
  const prepared = [];
  for (const t of tiles) {
    const entry = { label: t.label, rows: [] };
    for (const row of t.images) {
      if (!row.src) { entry.rows.push({ name: row.name, missing: true }); continue; }
      const loaded = await loadImage(row.src);
      if (loaded.error) { entry.rows.push({ name: row.name, error: loaded.error }); continue; }
      const img = fitBox(loaded.img, tileWidth - 8, maxImgHeight);
      entry.rows.push({ name: row.name, img, w: img.bitmap.width, h: img.bitmap.height });
    }
    const w = Math.max(tileWidth, ...entry.rows.map((r) => (r.w ?? 0) + 8));
    const rowsH = entry.rows.reduce((a, r) => a + (r.h ?? 0) + 4, 0);
    const labelH = stackLabels ? 22 : 0;
    entry.w = w; entry.h = labelH + rowsH + 6;
    prepared.push(entry);
  }
  const cellW = Math.max(...prepared.map((p) => p.w));
  const rowHeights = [];
  for (let i = 0; i < prepared.length; i += cols) {
    rowHeights.push(Math.max(...prepared.slice(i, i + cols).map((p) => p.h)));
  }
  const totalW = cols * cellW + (cols + 1) * gap;
  const totalH = rowHeights.reduce((a, h) => a + h + gap, gap);
  const sheet = blank(totalW, totalH, bg);

  const index = { out, cols, cellW, gap, tiles: [] };
  let y = gap;
  for (let i = 0; i < prepared.length; i += cols) {
    const rowH = rowHeights[i / cols];
    let x = gap;
    for (const cell of prepared.slice(i, i + cols)) {
      const tile = { label: cell.label, box: { x, y, w: cell.w, h: cell.h }, rows: [] };
      let ty = y;
      tile.labelBox = { x, y: ty, w: cell.w, h: 22 };
      if (stackLabels) {
        fillRect(sheet, { x, y: ty, w: cell.w, h: 22 }, 0x111318ff);
        drawLabel(sheet, cell.label.slice(0, 90), x + 4, ty + 4, { color: 0xffffffff, bg: null });
      }
      ty += stackLabels ? 22 : 0;
      for (const r of cell.rows) {
        if (r.img) {
          sheet.composite(r.img, x + 4, ty);
          tile.rows.push({ name: r.name, box: { x: x + 4, y: ty, w: r.w, h: r.h } });
          ty += r.h + 4;
        } else {
          drawLabel(sheet, `${r.name}: ${r.missing ? 'missing' : 'unreadable'}`, x + 4, ty + 2, { color: 0xff8844ff, bg: 0x000000ff });
          tile.rows.push({ name: r.name, box: { x: x + 4, y: ty, w: 240, h: 20 }, missing: true });
          ty += 24;
        }
      }
      index.tiles.push(tile);
      x += cellW + gap;
    }
    y += rowH + gap;
  }
  await savePng(sheet, out);
  return index;
}

/* -------------------------------------------------------------- grid diff --- */

/**
 * Cell-based diff with colour statistics. Returns clusters (connected groups of
 * changed cells) each with bbox + mean ref/build colour + share of the image.
 * `tolerance` is redmean distance (0..765): ~<30 is "same colour" for flat areas.
 */
export function gridDiff(a, b, { cell = 16, tolerance = 30, mask = [] } = {}) {
  const { w, h, data: da } = a;
  const db = b.data;
  const masked = new Uint8Array(w * h);
  let maskedPx = 0;
  for (const m of mask) {
    const x1 = clamp(Math.floor(m.x), 0, w), x2 = clamp(Math.ceil(m.x + m.w), 0, w);
    const y1 = clamp(Math.floor(m.y), 0, h), y2 = clamp(Math.ceil(m.y + m.h), 0, h);
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) if (!masked[y * w + x]) { masked[y * w + x] = 1; maskedPx++; }
  }
  const cx = Math.ceil(w / cell), cy = Math.ceil(h / cell);
  const cells = [];
  let diffPixels = 0, total = 0;
  for (let gy = 0; gy < cy; gy++) {
    for (let gx = 0; gx < cx; gx++) {
      const x0 = gx * cell, y0 = gy * cell;
      const x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
      let n = 0, nd = 0, sr = 0, sg = 0, sb = 0, tr = 0, tg = 0, tb = 0, sumDist = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, idx += 4) {
          const px = y * w + x;
          if (masked[px]) continue;
          const ar = da[idx], ag = da[idx + 1], ab = da[idx + 2];
          const br = db[idx], bg = db[idx + 1], bb = db[idx + 2];
          n++; sr += ar; sg += ag; sb += ab; tr += br; tg += bg; tb += bb;
          const d = colorDistance({ r: ar, g: ag, b: ab }, { r: br, g: bg, b: bb });
          sumDist += d;
          if (d > tolerance) nd++;
        }
      }
      if (!n) continue;
      total += n; diffPixels += nd;
      if (!nd) continue;
      cells.push({
        x: x0, y: y0, w: x1 - x0, h: y1 - y0, gx, gy,
        diffPixels: nd, px: n,
        refColor: { r: sr / n, g: sg / n, b: sb / n },
        buildColor: { r: tr / n, g: tg / n, b: tb / n },
        distance: sumDist / n,
      });
    }
  }
  const clusters = clusterCells(cells, { cell, w, h });
  return {
    width: w, height: h,
    totalPixels: total, diffPixels, maskedPixels: maskedPx,
    diffPct: total ? round((diffPixels / total) * 100, 3) : 0,
    cells, clusters,
  };
}

function clusterCells(cells, { cell, w, h }) {
  const byKey = new Map(cells.map((c) => [`${c.gx},${c.gy}`, c]));
  const seen = new Set();
  const clusters = [];
  for (const start of cells) {
    const k0 = `${start.gx},${start.gy}`;
    if (seen.has(k0)) continue;
    const stack = [start], group = [];
    seen.add(k0);
    while (stack.length) {
      const c = stack.pop();
      group.push(c);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${c.gx + dx},${c.gy + dy}`;
        const n = byKey.get(k);
        if (n && !seen.has(k)) { seen.add(k); stack.push(n); }
      }
    }
    const x1 = Math.min(...group.map((c) => c.x));
    const y1 = Math.min(...group.map((c) => c.y));
    const x2 = Math.max(...group.map((c) => c.x + c.w));
    const y2 = Math.max(...group.map((c) => c.y + c.h));
    const diffPixels = group.reduce((s, c) => s + c.diffPixels, 0);
    const px = group.reduce((s, c) => s + c.px, 0);
    const avg = (f) => ({ r: group.reduce((s, c) => s + c[f].r, 0) / group.length, g: group.reduce((s, c) => s + c[f].g, 0) / group.length, b: group.reduce((s, c) => s + c[f].b, 0) / group.length });
    const bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    const areaShare = round((diffPixels / Math.max(1, w * h)) * 100, 2);
    clusters.push({
      bbox, diffPixels, cells: group.length, areaShare,
      refColor: toHex(avg('refColor')), buildColor: toHex(avg('buildColor')),
      meanDistance: round(group.reduce((s, c) => s + c.distance, 0) / group.length, 1),
      shape: bbox.h <= 2 * cell && bbox.w >= 3 * bbox.h ? 'band'
        : areaShare >= 25 ? 'block'
          : bbox.w >= 2 * bbox.h ? 'strip' : 'patch',
      density: round((diffPixels / Math.max(1, bbox.w * bbox.h)) * 100, 1),
    });
  }
  return clusters.sort((p, q) => q.diffPixels - p.diffPixels);
}

/** Dominant colours in a region, quantised (for palette extraction / eyeballing). */
export function dominantColors(img, region = null, { max = 10, quant = 8 } = {}) {
  const { w, h, data } = { w: img.bitmap.width, h: img.bitmap.height, data: img.bitmap.data };
  const r = region ?? { x: 0, y: 0, w, h };
  const counts = new Map();
  const step = Math.max(1, Math.floor(Math.sqrt((r.w * r.h) / 40000)));
  for (let y = r.y; y < Math.min(h, r.y + r.h); y += step) {
    for (let x = r.x; x < Math.min(w, r.x + r.w); x += step) {
      const i = (y * w + x) * 4;
      const q = (v) => Math.round(v / quant) * quant;
      const key = `${q(data[i])},${q(data[i + 1])},${q(data[i + 2])},${data[i + 3]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const totalN = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, max)
    .map(([k, n]) => {
      const [r2, g2, b2, a2] = k.split(',').map(Number);
      return { hex: toHex({ r: r2, g: g2, b: b2 }), a: a2 / 255, share: round((n / totalN) * 100, 1) };
    });
}

/**
 * Search for the (dx, dy) that makes `b` line up with `a`. A large non-zero best
 * shift means the build is structurally right but *displaced* — the single most
 * useful diagnosis for a DOM diff, and unreachable from a plain diff %.
 */
export function findBestShift(a, b, { maxShift = 48, coarse = 4, sampleTarget = 20000, mask = [] } = {}) {
  const w = a.w, h = a.h;
  if (w !== b.w || h !== b.h) return { dx: 0, dy: 0, improvement: 0, reason: 'size-mismatch' };
  const masked = new Uint8Array(w * h);
  for (const m of mask) {
    const x1 = clamp(Math.floor(m.x), 0, w), x2 = clamp(Math.ceil(m.x + m.w), 0, w);
    for (let y = clamp(Math.floor(m.y), 0, h); y < clamp(Math.ceil(m.y + m.h), 0, h); y++) masked.fill(1, y * w + x1, y * w + x2);
  }
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / sampleTarget)));
  const cost = (dx, dy) => {
    let sum = 0, n = 0;
    const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
    const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const pa = y * w + x;
        if (masked[pa]) continue;
        const pb = (y + dy) * w + (x + dx);
        const ia = pa * 4, ib = pb * 4;
        sum += colorDistance({ r: a.data[ia], g: a.data[ia + 1], b: a.data[ia + 2] }, { r: b.data[ib], g: b.data[ib + 1], b: b.data[ib + 2] });
        n++;
      }
    }
    return n ? sum / n : Infinity;
  };
  const base = cost(0, 0);
  let best = { dx: 0, dy: 0, cost: base };
  for (let dy = -maxShift; dy <= maxShift; dy += coarse) {
    for (let dx = -maxShift; dx <= maxShift; dx += coarse) {
      const c = cost(dx, dy);
      if (c < best.cost) best = { dx, dy, cost: c };
    }
  }
  const ref = { ...best };
  for (let dy = ref.dy - coarse; dy <= ref.dy + coarse; dy++) {
    for (let dx = ref.dx - coarse; dx <= ref.dx + coarse; dx++) {
      const c = cost(dx, dy);
      if (c < best.cost) best = { dx, dy, cost: c };
    }
  }
  const improvement = base > 0 ? (base - best.cost) / base : 0;
  return { dx: best.dx, dy: best.dy, improvement: round(improvement * 100, 1), baseCost: round(base, 1), shiftedCost: round(best.cost, 1), step };
}

/** Uniformity of a region in one image (0..1): distinguishes "blank placeholder" from content. */
export function regionVariance(img, region) {
  const { w, h, data } = img;
  const r = { x: clamp(Math.floor(region.x), 0, w), y: clamp(Math.floor(region.y), 0, h) };
  r.w = clamp(Math.ceil(region.w), 1, w - r.x); r.h = clamp(Math.ceil(region.h), 1, h - r.y);
  let n = 0, sr = 0, sg = 0, sb = 0, s2 = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = (y * w + x) * 4;
    const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; s2 += v * v; n++;
  }
  if (!n) return { sd: 0, mean: 0 };
  const mean = (sr + sg + sb) / (3 * n);
  const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  return { sd: round(sd, 2), mean: round(mean, 2) };
}

/** pixelmatch fallback used when odiff's native binary misbehaves. */
export function pixelmatchScore(refImg, buildImg, outPath, { threshold = 0.1, mask = [] } = {}) {
  const width = refImg.w, height = refImg.h;
  if (width !== buildImg.w || height !== buildImg.h) return { sizeMismatch: `ref ${width}×${height} vs build ${buildImg.w}×${buildImg.h}` };
  const maskArr = new Uint8Array(width * height);
  for (const m of mask) {
    const x1 = clamp(Math.floor(m.x), 0, width), x2 = clamp(Math.ceil(m.x + m.w), 0, width);
    for (let y = clamp(Math.floor(m.y), 0, height); y < clamp(Math.ceil(m.y + m.h), 0, height); y++) maskArr.fill(255, y * width + x1, y * width + x2);
  }
  const out = new Uint8Array(width * height * 4);
  // alpha 0.1 (pixelmatch's default) renders an unchanged region almost white, so a
  // 0% diff looks like a blank tile; 0.35 keeps the page legible as context.
  const diffCount = pixelmatch(refImg.data, buildImg.data, out, width, height, { threshold, ignoreMask: maskArr, alpha: 0.35 });
  return { width, height, out, diffCount, maskArr, png: () => new Jimp({ width, height, data: Buffer.from(out.buffer), colorType: PNGColorType.RGBA }) };
}
export { parseColor, measureText, PNGColorType };
