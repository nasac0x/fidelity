// lib/checks.mjs — the check engine. Every acceptance criterion in validation.json
// is one of these types; validate.mjs only orchestrates widths/passes/retries.
//
// Types: exists · noExists · count · text · textContains · textMatches · style ·
//        boundingBox · attr · value · font · probe · noRequest · requestBudget ·
//        contrast · a11y · scrollHeight · visible · hover · focus · scroll
import { parseColor, colorDistance, contrast, wcagLevel, round } from './core.mjs';

export const TYPES = [
  'exists', 'noExists', 'count', 'text', 'textContains', 'textMatches', 'style', 'boundingBox',
  'attr', 'value', 'font', 'probe', 'noRequest', 'requestBudget', 'contrast', 'a11y', 'scrollHeight', 'visible',
  'hover', 'focus', 'scroll',
];

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const px = (v) => { const m = String(v).match(/^(-?[\d.]+)px$/); return m ? Number(m[1]) : null; };

/** One comparison rule for every state check (style, hover, focus). */
function styleMatches(actual, wanted, check = {}) {
  const a = norm(actual), w = norm(wanted);
  if (a === w) return true;
  if (check.colorTolerance !== undefined) {
    const ca = parseColor(a), cw = parseColor(w);
    if (ca && cw) return colorDistance(ca, cw) <= check.colorTolerance;
  }
  if (check.tolerancePx !== undefined) {
    const na = px(a), nw = px(w);
    if (na !== null && nw !== null) return Math.abs(na - nw) <= check.tolerancePx;
  }
  return false;
}

const styleOf = (loc, prop) =>
  loc.evaluate((el, p) => getComputedStyle(el)[p] ?? getComputedStyle(el).getPropertyValue(p), prop);

/** Viewport-relative box: what `position: sticky` is actually judged on. */
async function viewBox(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }, selector);
}

async function box(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height, visible: r.width > 0 || r.height > 0 };
  }, selector);
}

async function effectiveBackground(page, selector) {
  return page.evaluate((sel) => {
    let el = document.querySelector(sel);
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      const c = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : null;
      if (c) return c;
      el = el.parentElement;
    }
    return getComputedStyle(document.documentElement).backgroundColor || 'rgb(255, 255, 255)';
  }, selector);
}

export async function runCheck(page, check, ctx = {}) {
  const base = { type: check.type, selector: check.selector, prop: check.prop, from: check.from, soft: !!check.soft };
  const done = (pass, actual, detail) => ({ ...base, pass, actual: typeof actual === 'string' ? actual : String(actual ?? ''), detail });
  try {
    switch (check.type) {
      case 'exists':
      case 'noExists': {
        let n = await page.locator(check.selector).count();
        if (check.countFn) n = 0;
        const want = check.type === 'exists';
        return done(want ? n > 0 : n === 0, `${n} element(s)`);
      }
      case 'count': {
        const n = await page.locator(check.selector).count();
        if (check.min !== undefined || check.max !== undefined) {
          const ok = n >= (check.min ?? 0) && n <= (check.max ?? Infinity);
          return done(ok, n, `want ${check.min ?? 0}..${check.max ?? '∞'}`);
        }
        return done(n === check.equals, n, `want ${check.equals}`);
      }
      case 'visible': {
        const loc = page.locator(check.selector).first();
        if (!(await loc.count())) return done(false, 'not found');
        const vis = await loc.isVisible();
        return done(vis === (check.equals ?? true), String(vis));
      }
      case 'text': {
        const loc = page.locator(check.selector).first();
        if (!(await loc.count())) return done(false, 'selector not found');
        const raw = await loc.textContent();
        const t = norm(raw);
        const want = norm(check.equals);
        if (t === want) return done(true, t);
        return done(false, t, `want "${want.slice(0, 80)}"${t.length !== want.length ? ` (len ${t.length} vs ${want.length})` : ''}`);
      }
      case 'textContains': {
        const t = norm(await page.locator(check.selector).first().textContent().catch(() => ''));
        return done(t.includes(norm(check.equals)), t);
      }
      case 'textMatches': {
        const t = norm(await page.locator(check.selector).first().textContent().catch(() => ''));
        return done(new RegExp(check.pattern, check.flags ?? '').test(t), t);
      }
      case 'style': {
        const loc = page.locator(check.selector).first();
        if (!(await loc.count())) return done(false, 'selector not found');
        const actual = norm(await styleOf(loc, check.prop));
        const want = norm(check.equals);
        if (styleMatches(actual, want, check)) return done(true, actual);
        if (check.colorTolerance !== undefined) {
          const ca = parseColor(actual), cw = parseColor(want);
          if (ca && cw) {
            const d = colorDistance(ca, cw);
            return done(false, actual, `Δcolor=${round(d, 1)} (tol ${check.colorTolerance}) → want ${want}`);
          }
        }
        if (check.tolerancePx !== undefined) {
          const na = px(actual), nw = px(want);
          if (na !== null && nw !== null) {
            const d = Math.abs(na - nw);
            return done(false, actual, `Δ${round(d, 2)}px (tol ${check.tolerancePx}px) → want ${want}`);
          }
        }
        return done(false, actual, `want ${want}`);
      }
      case 'boundingBox': {
        const b = await box(page, check.selector);
        if (!b) return done(false, 'selector not found');
        const map = { left: b.x, x: b.x, top: b.y, y: b.y, width: b.width, height: b.height, right: b.x + b.width, bottom: b.y + b.height };
        const prop = map[check.prop] !== undefined ? check.prop : check.prop === 'w' ? 'width' : check.prop === 'h' ? 'height' : check.prop;
        const actual = map[prop];
        if (actual === undefined) return done(false, `bad prop ${check.prop}`, 'use left|x|top|y|width|height|right|bottom');
        const tol = check.tolerancePx ?? 2;
        if (check.minPx !== undefined || check.maxPx !== undefined) {
          const ok = actual >= (check.minPx ?? -Infinity) && actual <= (check.maxPx ?? Infinity);
          return done(ok, round(actual, 2), `want ${check.minPx ?? '-∞'}..${check.maxPx ?? '∞'}`);
        }
        const d = Math.abs(actual - check.approxPx);
        return done(d <= tol, round(actual, 2), `Δ${round(d, 2)}px (tol ${tol}px) → want ${check.approxPx}`);
      }
      case 'attr': {
        const v = await page.locator(check.selector).first().getAttribute(check.name).catch(() => null);
        return done(v === check.equals, v ?? '<absent>', `want ${check.equals}`);
      }
      case 'value': {
        const v = await page.evaluate(check.js);
        if (check.tolerancePx !== undefined && check.equals !== undefined) {
          const d = Math.abs(Number(v) - Number(check.equals));
          return done(d <= check.tolerancePx, v, `Δ${round(d, 2)} (tol ${check.tolerancePx})`);
        }
        return done(norm(v) === norm(check.equals), v, `want ${norm(check.equals)}`);
      }
      case 'font': {
        const ck = await page.evaluate(({ family, weight, style }) =>
          document.fonts.check(`${style ?? 'normal'} ${weight ?? 400} 16px "${family}"`), check);
        return done(!!ck, String(ck), `family "${check.family}" ${check.weight ?? 400} not available (silent fallback risk)`);
      }
      case 'contrast': {
        const fg = parseColor(await page.locator(check.selector).first().evaluate((el) => getComputedStyle(el).color));
        const bg = parseColor(await effectiveBackground(page, check.selector));
        const ratio = contrast(fg, bg);
        const min = check.minRatio ?? (check.level === 'AAA' ? (check.large ? 4.5 : 7) : (check.large ? 3 : 4.5));
        return done(ratio >= min, `${ratio}:1 (${wcagLevel(ratio, check.large)})`, `want ≥ ${min}:1`);
      }
      case 'a11y': {
        const res = await page.evaluate((rules) => {
          const out = [];
          for (const r of rules) {
            if (r === 'img-alt') {
              const bad = Array.from(document.images).filter((i) => i.alt === undefined || i.alt === null).length;
              out.push({ rule: r, bad, sel: 'img:not([alt])' });
            } else if (r === 'button-name') {
              const bad = Array.from(document.querySelectorAll('button,a[href]')).filter((b) => {
                const t = (b.textContent ?? '').trim();
                const label = b.getAttribute('aria-label') || b.getAttribute('title') || t;
                return !label;
              }).length;
              out.push({ rule: r, bad });
            } else if (r === 'html-lang') {
              out.push({ rule: r, bad: document.documentElement.lang ? 0 : 1 });
            } else if (r === 'title') {
              out.push({ rule: r, bad: document.title ? 0 : 1 });
            } else if (r === 'h1-once') {
              out.push({ rule: r, bad: Math.abs(document.querySelectorAll('h1').length - 1) });
            }
          }
          return out;
        }, check.rules ?? ['img-alt', 'button-name', 'html-lang', 'title', 'h1-once']);
        const bad = res.filter((r) => r.bad > 0);
        return done(bad.length === 0, bad.length ? bad.map((b) => `${b.rule}:${b.bad}`).join(' ') : 'clean', JSON.stringify(res));
      }
      case 'scrollHeight': {
        const v = await page.evaluate(() => document.documentElement.scrollHeight);
        const tol = check.tolerancePx ?? 12;
        return done(Math.abs(v - check.approxPx) <= tol, v, `Δ${Math.abs(v - check.approxPx)}px (tol ${tol}px) → want ${check.approxPx}`);
      }
      case 'noRequest': {
        const reqs = ctx.requests ?? [];
        const deny = (check.denyHosts ?? []).map((h) => h.toLowerCase());
        const bad = reqs.filter((u) => { try { const h = new URL(u).host.toLowerCase(); return deny.some((d) => h === d || h.endsWith(`.${d}`)); } catch { return false; } });
        return done(bad.length === 0, bad.length ? `${bad.length} request(s): ${[...new Set(bad.map((u) => new URL(u).host))].slice(0, 3).join(', ')}` : `${reqs.length} requests, none to denied hosts`);
      }
      case 'requestBudget': {
        const reqs = ctx.requests ?? [];
        const bytes = ctx.bytes ?? 0;
        const problems = [];
        if (check.maxRequests && reqs.length > check.maxRequests) problems.push(`${reqs.length} requests > ${check.maxRequests}`);
        if (check.maxKb && bytes / 1024 > check.maxKb) problems.push(`${round(bytes / 1024, 1)}KB > ${check.maxKb}KB`);
        return done(problems.length === 0, problems.join('; ') || `${reqs.length} requests, ${round(bytes / 1024, 1)}KB`);
      }
      case 'hover': {
        const loc = page.locator(check.selector).first();
        if (!(await loc.count())) return done(false, 'selector not found');
        const settle = check.settle ?? 250;
        const before = norm(await styleOf(loc, check.prop));
        await loc.hover({ timeout: 5000 });
        await page.waitForTimeout(settle);
        const during = norm(await styleOf(loc, check.prop));
        await page.mouse.move(1, 1);
        await page.waitForTimeout(settle);
        const after = norm(await styleOf(loc, check.prop));
        const problems = [];
        if (check.equals !== undefined && !styleMatches(during, check.equals, check)) problems.push(`hover ${during} ≠ ${norm(check.equals)}`);
        if (check.requireChange !== false && during === before) problems.push(`no change on hover (${before})`);
        if (check.restore !== false && after !== before) problems.push(`not restored (${after} ≠ ${before})`);
        return done(problems.length === 0, `${before} → ${during} → ${after}`, problems.join('; ') || undefined);
      }
      case 'focus': {
        const loc = page.locator(check.selector).first();
        if (!(await loc.count())) return done(false, 'selector not found');
        const settle = check.settle ?? 150;
        const before = norm(await styleOf(loc, check.prop));
        if ((check.via ?? 'focus') === 'tab') {
          const maxTabs = check.maxTabs ?? 40;
          let hit = false;
          for (let i = 0; i < maxTabs && !hit; i++) {
            await page.keyboard.press('Tab');
            hit = await page.evaluate((sel) => !!(document.activeElement && document.activeElement.matches(sel)), check.selector);
          }
          if (!hit) return done(false, `not reached in ${maxTabs} tabs`, 'via:tab — is the element focusable and in DOM order?');
        } else {
          await loc.focus();
        }
        await page.waitForTimeout(settle);
        const during = norm(await styleOf(loc, check.prop));
        await page.evaluate(() => document.activeElement?.blur());
        await page.waitForTimeout(settle);
        const after = norm(await styleOf(loc, check.prop));
        const problems = [];
        if (check.equals !== undefined && !styleMatches(during, check.equals, check)) problems.push(`focus ${during} ≠ ${norm(check.equals)}`);
        if (check.requireChange !== false && during === before) problems.push(`no visible focus style (${before})`);
        if (check.restore !== false && after !== before) problems.push(`not restored (${after} ≠ ${before})`);
        return done(problems.length === 0, `${before} → ${during} → ${after}`, problems.join('; ') || undefined);
      }
      case 'scroll': {
        const y = Number(check.scrollTo ?? check.y ?? 0);
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await page.waitForTimeout(check.settle ?? 200);
        const b = await viewBox(page, check.selector);
        if (!b) return done(false, 'selector not found');
        const problems = [];
        if (check.position) {
          const p = await page.locator(check.selector).first().evaluate((el) => getComputedStyle(el).position);
          if (p !== check.position) problems.push(`position ${p} (want ${check.position})`);
        }
        const tol = check.tolerancePx ?? 2;
        if (check.viewportTop !== undefined && Math.abs(b.top - check.viewportTop) > tol) problems.push(`top ${round(b.top, 1)} (want ${check.viewportTop}±${tol})`);
        if (check.viewportLeft !== undefined && Math.abs(b.left - check.viewportLeft) > tol) problems.push(`left ${round(b.left, 1)} (want ${check.viewportLeft}±${tol})`);
        if (check.visible === true) {
          const h = page.viewportSize()?.height ?? 900;
          if (!(b.width > 0 && b.height > 0 && b.top < h && b.top + b.height > 0)) problems.push('not in viewport after scroll');
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        return done(problems.length === 0, `top ${round(b.top, 1)} left ${round(b.left, 1)} ${round(b.width, 1)}×${round(b.height, 1)}`, problems.join('; ') || undefined);
      }
      case 'probe': {
        const trace = [];
        for (const step of check.steps ?? []) {
          if (step.hover) { await page.locator(step.hover).first().hover({ timeout: 5000 }); trace.push(`hover ${step.hover}`); }
          else if (step.click) { await page.locator(step.click).first().click({ timeout: 5000 }); trace.push(`click ${step.click}`); }
          else if (step.scrollTo !== undefined) { await page.evaluate((y) => window.scrollTo(0, y), step.scrollTo); trace.push(`scrollTo ${step.scrollTo}`); }
          else if (step.scrollIntoView) { await page.locator(step.scrollIntoView).first().scrollIntoViewIfNeeded(); trace.push(`into view ${step.scrollIntoView}`); }
          else if (step.press) { await page.keyboard.press(step.press); trace.push(`press ${step.press}`); }
          else if (step.evaluate) { await page.evaluate(step.evaluate); trace.push('evaluate'); }
          else if (step.wait !== undefined) { await page.waitForTimeout(step.wait); trace.push(`wait ${step.wait}ms`); }
          else if (step.setViewport) { await page.setViewportSize({ width: step.setViewport.w ?? step.setViewport.width, height: step.setViewport.h ?? step.setViewport.height }); trace.push('setViewport'); }
          if (step.after !== undefined) await page.waitForTimeout(step.after);
        }
        const expect = check.expect ?? {};
        const sub = expect.style ? { type: 'style', ...expect.style } : expect.box ? { type: 'boundingBox', ...expect.box }
          : expect.text ? { type: 'text', ...expect.text } : expect.js ? { type: 'value', ...expect.js } : null;
        if (!sub) return done(false, `probe ran (${trace.join(' → ')})`, 'no expect clause');
        const res = await runCheck(page, sub, ctx);
        return { ...res, type: 'probe', from: check.from, soft: !!check.soft, steps: trace.join(' → '), actual: res.actual, pass: res.pass, detail: res.detail };
      }
      default:
        return done(false, `unknown check type "${check.type}"`, `known: ${TYPES.join(', ')}`);
    }
  } catch (err) {
    return done(false, `error: ${String(err).slice(0, 160)}`);
  }
}
