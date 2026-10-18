// lib/browser.mjs — Playwright helpers shared by every capturing/validating script.
// One place for: launch, page setup, deterministic settling (lazy-load + overlays),
// font/asset inventory, layout signatures and element screenshots.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, warn } from './core.mjs';

/* --------------------------------------------------------------- lifecycle --- */

export async function withBrowser(fn, { headless = true, args = [] } = {}) {
  const browser = await chromium.launch({ headless, args });
  try { return await fn(browser); } finally { await browser.close().catch(() => { }); }
}

export async function newPage(browser, cfg = {}) {
  const context = await browser.newContext({
    viewport: { width: cfg.width ?? 1366, height: cfg.height ?? 900 },
    deviceScaleFactor: cfg.scale ?? 1,
    reducedMotion: cfg.reducedMotion ? 'reduce' : 'no-preference',
    locale: cfg.locale ?? 'pt-BR',
    colorScheme: cfg.colorScheme ?? 'light',
    userAgent: cfg.userAgent,
    isMobile: cfg.isMobile ?? false,
    hasTouch: cfg.hasTouch ?? false,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(cfg.timeoutMs ?? 30000);
  return { page, context };
}

/** goto + settling: network idle → optional dismissals → lazy-load scroll → settle. */
export async function prepare(page, cfg = {}) {
  const { url } = cfg;
  if (!url) throw new Error('prepare(): url is required');
  await page.goto(url, { waitUntil: cfg.waitUntil ?? 'load', timeout: cfg.timeoutMs ?? 30000 });
  if (cfg.waitFor) {
    await page.waitForSelector(cfg.waitFor, { timeout: cfg.timeoutMs ?? 30000 }).catch(() => warn(`waitFor not found: ${cfg.waitFor}`));
  }
  for (const sel of cfg.dismiss ?? []) {
    await page.locator(sel).first().click({ timeout: 3000 }).catch(() => { });
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(cfg.settleMs ?? 500);
  if (cfg.scrollThrough !== false) await scrollThrough(page);
  await page.waitForTimeout(Math.round((cfg.settleMs ?? 500) / 2));
  return page;
}

/** Walk the page so lazy images/videos are actually loaded before capture. */
export async function scrollThrough(page, { step = 0.8, pause = 180 } = {}) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = page.viewportSize()?.height ?? 900;
  for (let y = 0; y < height; y += Math.round(vh * step)) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y).catch(() => { });
    await page.waitForTimeout(pause);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => { });
  await page.waitForTimeout(pause);
  // wait for images that are still decoding
  await page.evaluate(() => Promise.all(Array.from(document.images).filter((i) => !i.complete)
    .map((i) => new Promise((res) => { i.addEventListener('load', res, { once: true }); i.addEventListener('error', res, { once: true }); setTimeout(res, 3000); })))).catch(() => { });
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { });
  await page.waitForTimeout(pause);
}

/* ------------------------------------------------------------- page probes --- */

/** @font-face declarations + loaded FontFace entries. */
export async function collectFontFaces(page) {
  return page.evaluate(() => {
    const faces = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of Array.from(rules ?? [])) {
        if (r.constructor?.name === 'CSSFontFaceRule' || r instanceof CSSFontFaceRule) {
          const src = r.style.getPropertyValue('src') ?? '';
          faces.push({
            family: (r.style.getPropertyValue('font-family') ?? '').replace(/^["']|["']$/g, ''),
            weight: r.style.getPropertyValue('font-weight') || '400',
            style: r.style.getPropertyValue('font-style') || 'normal',
            display: r.style.getPropertyValue('font-display') || '',
            range: r.style.getPropertyValue('unicode-range') || '',
            urls: Array.from(src.matchAll(/url\((["']?)([^"')]+)\1\)/g)).map((m) => m[2]),
            source: src.includes('local(') ? 'local+url' : src ? 'url' : 'none',
          });
        }
      }
    }
    const loaded = Array.from(document.fonts ?? []).map((f) => ({ family: f.family, weight: f.weight, style: f.style, status: f.status }));
    return { faces, loaded };
  });
}

/**
 * Measure text metrics for a list of families (canvas). Used to build a
 * metric-compatible fallback: avg advance width ratio + ascent/descent/line-gap
 * overrides that CSS understands.
 */
export async function measureFontMetrics(page, families, probe = 'Hamburgefonstiv ABC xyz 0123456789') {
  return page.evaluate(({ families, probe }) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const out = [];
    const ref = 'sans-serif';
    const measure = (family) => {
      ctx.font = `100px ${family}`;
      const m = ctx.measureText(probe);
      const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? 0;
      const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? 0;
      const charAdv = probe.split('').map((ch) => ctx.measureText(ch).width);
      const spaceAdv = ctx.measureText(' ').width;
      return { family, width: +m.width.toFixed(2), ascent: +ascent.toFixed(2), descent: +descent.toFixed(2), charAdv: charAdv.map((v) => +v.toFixed(2)), spaceAdv: +spaceAdv.toFixed(2) };
    };
    out.push(measure(ref));
    for (const f of families) out.push(measure(f));
    // also expose installed candidates through a wide request set
    return out;
  }, { families, probe });
}

/** Layout fingerprint at the current viewport (used for breakpoint inference). */
export async function layoutSignature(page, selectors = []) {
  return page.evaluate((selectors) => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: +(r.x + scrollX).toFixed(1), y: +(r.y + scrollY).toFixed(1),
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        fs: cs.fontSize, cols: cs.gridTemplateColumns, dir: cs.flexDirection, disp: cs.display,
      };
    };
    const textNodes = Array.from(document.querySelectorAll('h1,h2,h3,p,li,span,a,button'))
      .filter((el) => el.childNodes.length && el.textContent.trim())
      .slice(0, 40)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { t: el.textContent.trim().slice(0, 24), x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), fs: getComputedStyle(el).fontSize };
      });
    return {
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      landmarks: Object.fromEntries(['header', 'nav', 'main', 'h1', 'footer', ...selectors].map((s) => [s, pick(s)])),
      textNodes,
    };
  }, selectors);
}

/**
 * Full element inventory with ABSOLUTE document boxes (aligned with a fullPage
 * screenshot), prioritised so text-bearing nodes are never lost to the cap.
 */
export async function collectInventory(page, { cap = 900, focus = null, visibleOnly = true } = {}) {
  return page.evaluate(({ cap, focus, visibleOnly }) => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'BR', 'TEMPLATE', 'BASE']);
    const LANDMARK = new Set(['HEADER', 'NAV', 'MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'VIDEO', 'SVG', 'BUTTON', 'A', 'INPUT', 'FORM', 'UL', 'LI', 'P', 'CANVAS', 'IFRAME', 'PICTURE', 'SOURCE', 'LABEL', 'SELECT', 'TEXTAREA', 'TABLE', 'DIALOG']);
    const root = focus ? document.querySelector(focus) : document.body;
    if (!root) return { error: `focus selector not found: ${focus}`, items: [], truncated: false, cap };
    const all = [];
    const walk = (el, depth) => {
      for (const child of Array.from(el.children)) {
        if (SKIP.has(child.tagName)) continue;
        all.push({ el: child, depth });
        walk(child, depth + 1);
      }
    };
    walk(root, 0);
    const sx = window.scrollX, sy = window.scrollY;
    const rows = [];
    let dropped = 0;
    for (const { el, depth } of all) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const hidden = cs.display === 'none' || cs.visibility === 'hidden' || (+cs.opacity === 0);
      const zero = r.width === 0 && r.height === 0;
      if (visibleOnly && (hidden || zero)) { dropped++; continue; }
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean).join(' ');
      const directImgs = Array.from(el.children).filter((c) => c.tagName === 'IMG').map((c) => c.currentSrc || c.src).filter(Boolean);
      const bg = cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 120) : undefined;
      const hasPaint = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || bg !== undefined || cs.borderRadius !== '0px' || cs.borderTopWidth !== '0px';
      const landmark = LANDMARK.has(el.tagName);
      const score = (ownText ? 1000 : 0) + (directImgs.length ? 500 : 0) + (landmark ? 200 : 0) + (hasPaint ? 100 : 0) - depth;
      if (!ownText && !hasPaint && !landmark && !directImgs.length) { dropped++; continue; }
      rows.push({
        score, el, depth,
        rec: {
          d: depth,
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          cls: typeof el.className === 'string' && el.className ? el.className.slice(0, 160) : undefined,
          text: ownText ? ownText.slice(0, 300) : undefined,
          box: [+(r.x + sx).toFixed(1), +(r.y + sy).toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)],
          font: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
          fw: cs.fontWeight, fs: cs.fontSize, lh: cs.lineHeight, ls: cs.letterSpacing === 'normal' ? undefined : cs.letterSpacing,
          color: cs.color,
          bg: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : undefined,
          bgi: bg,
          br: cs.borderRadius !== '0px' ? cs.borderRadius : undefined,
          pos: cs.position !== 'static' ? cs.position : undefined,
          ov: cs.overflow !== 'visible' ? cs.overflow : undefined,
          op: cs.opacity !== '1' ? +cs.opacity : undefined,
          tr: cs.transform !== 'none' ? cs.transform.slice(0, 80) : undefined,
          // layout facts needed for codegen (only non-defaults, to keep the dump lean)
          L: (() => {
            const L = {};
            if (cs.display && !['block', 'inline', 'inline-block'].includes(cs.display)) L.disp = cs.display;
            if (cs.gridTemplateColumns && cs.gridTemplateColumns !== 'none') L.gtc = cs.gridTemplateColumns.slice(0, 120);
            if (cs.display.includes('flex') && cs.flexDirection !== 'row') L.fd = cs.flexDirection;
            if (cs.display.includes('flex') && cs.flexWrap !== 'nowrap') L.fw = cs.flexWrap;
            if (cs.display.includes('flex') && cs.gap !== 'normal') L.gap = cs.gap;
            if (cs.display.includes('grid') && cs.gap !== 'normal') L.gap = cs.gap;
            if (cs.display.includes('flex') && cs.alignItems !== 'normal') L.ai = cs.alignItems;
            if (cs.display.includes('flex') && cs.justifyContent !== 'normal') L.jc = cs.justifyContent;
            if (cs.padding !== '0px') L.pad = cs.padding;
            if (cs.margin !== '0px') L.mar = cs.margin;
            if (cs.width !== 'auto' && cs.position !== 'static') L.w = cs.width;
            if (cs.maxWidth !== 'none') L.mw = cs.maxWidth;
            if (cs.textAlign !== 'start') L.ta = cs.textAlign;
            if (cs.flex !== '0 1 auto' && cs.flex !== '0 1 0%') L.fl = cs.flex;
            return Object.keys(L).length ? L : undefined;
          })(),
          imgs: directImgs.length ? directImgs.map((u) => u.slice(0, 200)) : undefined,
          landmark: landmark || undefined,
        },
      });
    }
    rows.sort((a, b) => b.score - a.score || a.depth - b.depth);
    const kept = rows.slice(0, cap);
    kept.sort((a, b) => (a.rec.d - b.rec.d) || (a.rec.box[1] - b.rec.box[1]) || (a.rec.box[0] - b.rec.box[0]));
    return {
      items: kept.map((k) => k.rec),
      truncated: rows.length > cap,
      candidates: rows.length,
      dropped,
      cap,
      focus: focus ?? 'body',
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  }, { cap, focus, visibleOnly });
}

/** Assets, external origins and transfer stats (feeds Stage 3 + `noRequest` checks). */
export async function collectAssets(page) {
  return page.evaluate(() => {
    const images = Array.from(document.images).map((i) => ({
      url: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight,
      alt: i.alt ?? '', loading: i.loading || 'eager', srcset: i.getAttribute('srcset') || undefined,
      complete: i.complete,
    })).filter((i) => i.url);
    const videos = Array.from(document.querySelectorAll('video')).map((v) => ({
      url: v.currentSrc || v.querySelector('source')?.src || '', poster: v.poster || undefined,
      muted: v.muted, loop: v.loop, autoplay: v.autoplay, playsInline: v.playsInline,
      w: v.videoWidth, h: v.videoHeight, duration: Number.isFinite(v.duration) ? +v.duration.toFixed(3) : null,
      controls: v.controls, preload: v.preload,
      sources: Array.from(v.querySelectorAll('source')).map((s) => ({ src: s.src, type: s.type })),
    }));
    const icons = Array.from(document.querySelectorAll('link[rel="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]')).map((l) => l.href);
    const resources = performance.getEntriesByType('resource').map((r) => ({
      url: r.name, type: r.initiatorType, bytes: r.transferSize || r.encodedBodySize || 0, ms: Math.round(r.duration),
    }));
    const media = resources.filter((r) => /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(r.url) || r.type === 'css' && /font/i.test(r.url));
    const origins = Array.from(new Set(resources.map((r) => { try { return new URL(r.url).origin; } catch { return ''; } }).filter(Boolean)));
    return {
      images, videos, icons,
      fonts: resources.filter((r) => /\.(woff2?|ttf|otf)(\?|$)/i.test(r.url) || /fonts?\./i.test(r.url)).map((r) => r.url),
      mediaCount: media.length,
      styles: resources.filter((r) => r.type === 'link' && /\.css(\?|$)/i.test(r.url)).map((r) => r.url),
      scripts: resources.filter((r) => r.type === 'script').map((r) => r.url),
      resources,
      origins,
      origin: location.origin,
      meta: {
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content ?? '',
        lang: document.documentElement.lang,
        ogImage: document.querySelector('meta[property="og:image"]')?.content ?? '',
        viewportMeta: document.querySelector('meta[name="viewport"]')?.content ?? '',
      },
    };
  });
}

export async function shootElement(page, selector, outPath, { timeout = 8000 } = {}) {
  ensureDir(path.dirname(outPath));
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return { error: `no element for ${selector}` };
  await loc.scrollIntoViewIfNeeded({ timeout }).catch(() => { });
  await loc.screenshot({ path: outPath, timeout });
  return { path: outPath };
}
export function fileExists(p) { return fs.existsSync(p); }
