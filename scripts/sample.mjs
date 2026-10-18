// Sample pixel colors from PNG shots: distinct colors + dot map in a region, and point samples.
// usage: node sample.mjs <img> --points "x1,y1;x2,y2" [--region "x,y,w,h"]
import { Jimp } from 'jimp';

const file = process.argv[2];
const take = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};
const img = await Jimp.read(file);

const points = take('--points');
if (points) {
  for (const p of points.split(';')) {
    const [x, y] = p.split(',').map(Number);
    const c = img.getPixelColor(x, y);
    const r = (c >> 24) & 255, g = (c >> 16) & 255, b = (c >> 8) & 255;
    console.log(`${p} -> rgb(${r},${g},${b}) #${
      [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
    }`);
  }
}

const region = take('--region');
if (region) {
  const [rx, ry, rw, rh] = region.split(',').map(Number);
  const counts = new Map();
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const c = img.getPixelColor(x, y);
      const r = (c >> 24) & 255, g = (c >> 16) & 255, b = (c >> 8) & 255;
      const key = `${r},${g},${b}`;
      const e = counts.get(key) || { n: 0, minx: 1e9, miny: 1e9, maxx: -1, maxy: -1 };
      e.n++; e.minx = Math.min(e.minx, x); e.miny = Math.min(e.miny, y);
      e.maxx = Math.max(e.maxx, x); e.maxy = Math.max(e.maxy, y);
      counts.set(key, e);
    }
  }
  const list = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
  console.log(`region ${region}`);
  for (const [key, e] of list) console.log(`  rgb(${key}) n=${e.n} bbox=(${e.minx},${e.miny})-(${e.maxx},${e.maxy})`);
}
