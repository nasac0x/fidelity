#!/usr/bin/env node
// EXTRACT — measure a reference page at several widths, in parallel.
// Writes per-width screenshots + NDJSON inventory (never loaded wholesale: use
// digest.mjs) + merged assets/fonts + run.json (hashes, versions, timings).
//
//   node extract.mjs --url http://localhost:3000 --out import
//   node extract.mjs --url https://site.com --focus "section.hero" --shots "hero:section.hero"
//   node extract.mjs --url ... --widths-file breaks.json
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, arr, flag, num, str, csv, parsePairs, loadConfig, readJsonSafe,
  writeJson, writeNdjson, ensureDir, sha256, rel, stamp, PKG, usage, summary, warn,
} from './lib/core.mjs';
import { withBrowser, newPage, prepare, collectInventory, collectAssets, collectFontFaces, shootElement } from './lib/browser.mjs';

const A = parseArgs();
if (!A.url && !A._[0]) usage(`Usage: node extract.mjs --url <URL> --out <dir> [--widths 320,390,...] [--focus "sel"] [--shots "key:sel;;key2:sel2"]`);
const cfg = loadConfig(A);
const url = str(A.url, A._[0]);
const outDir = path.resolve(str(A.out, 'import'));
ensureDir(outDir);

const widths = A.widthsFile
  ? (readJsonSafe(path.resolve(String(A.widthsFile)))?.ladder ?? csv(str(A.widths))).map(Number).filter((n) => n > 0)
  : csv(str(A.widths)).length ? csv(str(A.widths)) : cfg.widths;
const shots = parsePairs(A.shots);
const focus = str(A.focus, null);
const cap = num(A.cap, 900);
const workers = Math.max(1, Math.min(num(A.workers, cfg.workers), widths.length));
const startedAt = stamp();

const pages = [];
const shotsIndex = {};

await withBrowser(async (browser) => {
  let next = 0;
  const runWorker = async (id) => {
    while (true) {
      const i = next++;
      if (i >= widths.length) return;
      const width = widths[i];
      const t0 = Date.now();
      let context;
      try {
        const made = await newPage(browser, { ...cfg, width, scale: num(A.scale, cfg.scale) });
        const page = made.page;
        context = made.context;
        await prepare(page, {
          url, timeoutMs: cfg.timeoutMs, settleMs: num(A.settle, cfg.settleMs),
          scrollThrough: !flag(A.noScroll) && cfg.scrollThrough !== false,
          dismiss: arr(A.dismiss), waitFor: str(A.waitFor, null),
        });

        const shot = path.join(outDir, `reference-${width}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        const html = await page.content();
        fs.writeFileSync(path.join(outDir, `page-${width}.html`), html);

        const inv = await collectInventory(page, { cap, focus, visibleOnly: !flag(A.allNodes) });
        if (inv.error) warn(`  ! ${width}px inventory: ${inv.error}`);
        const invPath = writeNdjson(path.join(outDir, `inventory-${width}.ndjson`), inv.items ?? []);

        const assets = await collectAssets(page);
        const fonts = await collectFontFaces(page);

        for (const { key, selector } of shots) {
          const p = path.join(outDir, `element-${width}-${key}.png`);
          const r = await shootElement(page, selector, p).catch((e) => ({ error: String(e).slice(0, 120) }));
          if (!r.error) (shotsIndex[key] ??= {})[width] = rel(p, process.cwd());
          else warn(`  ✗ element shot ${key}@${width}: ${r.error}`);
        }

        const density = inv.scrollHeight ? +(inv.scrollHeight / 900).toFixed(2) : 0;
        pages.push({
          width, ok: true, ms: Date.now() - t0,
          screenshot: rel(shot, process.cwd()),
          html: rel(path.join(outDir, `page-${width}.html`), process.cwd()),
          inventory: rel(invPath, process.cwd()),
          htmlSha256: sha256(html),
          counts: { items: (inv.items ?? []).length, candidates: inv.candidates, dropped: inv.dropped },
          truncated: !!inv.truncated,
          scrollHeight: inv.scrollHeight, scrollWidth: inv.scrollWidth,
          viewport: inv.viewport, density,
          fontFaces: fonts.faces.length, loadedFonts: fonts.loaded.length,
          assets: { images: assets.images.length, videos: assets.videos.length, fonts: assets.fonts.length, scripts: assets.scripts.length, styles: assets.styles.length },
          // Raw arrays are needed by the merge below (counting is not enough to
          // pin sources). inventory.json strips them again to stay small.
          images: assets.images, videos: assets.videos, icons: assets.icons,
          fonts: assets.fonts, styles: assets.styles, scripts: assets.scripts,
          meta: assets.meta, origins: assets.origins,
        });
        console.log(`✓ ${String(width).padStart(4)}px  ${String((inv.items ?? []).length).padStart(4)}/${inv.candidates} nodes  ${assets.images.length} img  ${inv.scrollHeight}px tall  ${Date.now() - t0}ms${inv.truncated ? '  ⚠ TRUNCATED' : ''}`);
      } catch (err) {
        pages.push({ width, ok: false, error: String(err).slice(0, 300), ms: Date.now() - t0 });
        warn(`✗ ${width}px → ${String(err).slice(0, 200)}`);
      } finally {
        await context?.close().catch(() => { });
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, i) => runWorker(i)));
});

pages.sort((a, b) => a.width - b.width);
const ok = pages.filter((p) => p.ok);

// merged assets / fonts (dedup by url, keeping the largest reported size)
const byUrl = new Map();
for (const p of ok) for (const img of p.images ?? []) {
  const prev = byUrl.get(img.url);
  if (!prev || (img.w * img.h) > (prev.w * prev.h)) byUrl.set(img.url, { ...img, seenAt: [...new Set([...(prev?.seenAt ?? []), p.width])] });
}
const assetsMerged = {
  url, extractedAt: stamp(),
  images: [...byUrl.values()],
  videos: (ok.find((p) => p.videos?.length)?.videos) ?? [],
  icons: [...new Set(ok.flatMap((p) => p.icons ?? []))],
  fonts: [...new Set(ok.flatMap((p) => p.fonts ?? []))],
  styles: [...new Set(ok.flatMap((p) => p.styles ?? []))],
  scripts: [...new Set(ok.flatMap((p) => p.scripts ?? []))],
  origins: [...new Set(ok.flatMap((p) => p.origins ?? []))],
  meta: ok[0]?.meta ?? {},
};
writeJson(path.join(outDir, 'assets.json'), assetsMerged);

writeJson(path.join(outDir, 'inventory.json'), {
  url, extractedAt: stamp(), focus, cap, widthCount: widths.length, widths,
  truncated: ok.some((p) => p.truncated),
  hint: 'Do NOT read this file or inventory-<w>.ndjson wholesale. Use: node digest.mjs --dir <out> --width <w>',
  pages: pages.map(({ resources: _r, images: _i, videos: _v, icons: _ic, fonts: _f, styles: _s, scripts: _sc, ...rest }) => rest),
});

writeJson(path.join(outDir, 'shots.json'), shotsIndex);
writeJson(path.join(outDir, 'run.json'), {
  kind: 'extract', url, startedAt, finishedAt: stamp(),
  skill: 'fidelity', skillVersion: PKG.version,
  node: process.version, playwright: PKG.dependencies?.playwright ?? 'n/a',
  config: { widths, height: cfg.height, scale: num(A.scale, cfg.scale), settleMs: num(A.settle, cfg.settleMs), workers, scrollThrough: !flag(A.noScroll) },
  hashes: Object.fromEntries(ok.map((p) => [`html@${p.width}`, p.htmlSha256])),
});

summary('extract', {
  out: rel(outDir, process.cwd()),
  widths: ok.map((p) => p.width),
  failed: pages.filter((p) => !p.ok).map((p) => p.width),
  nodes: ok.reduce((s, p) => s + (p.counts.items ?? 0), 0),
  images: assetsMerged.images.length,
  truncated: ok.some((p) => p.truncated),
  ms: pages.reduce((s, p) => s + (p.ms ?? 0), 0),
});
console.log(`Next: node digest.mjs --dir ${rel(outDir, process.cwd())} --width ${ok.at(-1)?.width ?? widths.at(-1)} --outline`);
process.exit(ok.length ? 0 : 1);
