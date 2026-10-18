// Print horizontal/vertical color runs along slices of a PNG.
// usage: node scan.mjs <img> --rows "y1;y2;..." [--x0 X --x1 X] --cols "x1;x2;" [--y0 Y --y1 Y] [--step N]
import { Jimp } from 'jimp';

const file = process.argv[2];
const take = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const img = await Jimp.read(file);
function getPx(img, x, y) {
  const c = img.getPixelColor(x, y);
  return { r: (c >> 24) & 255, g: (c >> 16) & 255, b: (c >> 8) & 255 };
}
const hex = (c) => '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');

const pr = (...pairs) => console.log(...pairs);
const rows = take('--rows'); const cols = take('--cols');
const step = parseInt(take('--step') || '1', 10);

function runs(list) {
  const out = [];
  let cur = null;
  for (const [i, px] of list) {
    const h = hex(px);
    if (!cur || cur.c !== h) { if (cur) out.push(cur); cur = { c: h, s: i, e: i }; }
    else { cur.e = i; }
  }
  if (cur) out.push(cur);
  // merge tiny nuance runs: keep runs >= step*2 px, else fuse into previous
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (r.e - r.s + 1 < step && last) { last.e = r.e; continue; }
    merged.push(r);
  }
  return merged.map(r => `${r.c}[${r.s}..${r.e}]`).join(' ');
}

if (rows) {
  const [x0, x1] = [(parseInt(take('--x0') || '0', 10)), parseInt(take('--x1') || String(img.bitmap.width - 1), 10)];
  for (const ys of rows.split(';').filter(Boolean).map(Number)) {
    const list = [];
    for (let x = x0; x <= x1; x += step) list.push([x, getPx(img, x, ys)]);
    pr(`y=${ys}: `, runs(list));
  }
}
if (cols) {
  const [y0, y1] = [parseInt(take('--y0') || '0', 10), parseInt(take('--y1') || String(img.bitmap.height - 1), 10)];
  for (const xs of cols.split(';').filter(Boolean).map(Number)) {
    const list = [];
    for (let y = y0; y <= y1; y += step) list.push([y, getPx(img, xs, y)]);
    pr(`x=${xs}: `, runs(list));
  }
}
