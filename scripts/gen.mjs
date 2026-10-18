#!/usr/bin/env node
// GEN — Tier-2 mode: generate a whole site from a brief (no reference needed).
// Same pipeline, same gates: it writes its own `site.json` (the machine spec) and
// `validation.json`, so `validate.mjs` + `visual-diff.mjs` + `budgets.mjs` apply.
//
//   node gen.mjs --name "Northwind" --niche saas --locale pt-BR --out "C:/.../PROJETOS/northwind"
//   node gen.mjs --brief brief.json --stack react --seed 42
//
// Design-system rules are enforced as code: 4px spacing grid, modular type scale,
// WCAG-checked palette (auto-darkened until AA), one radius family, no orphan tokens.
import path from 'node:path';
import fs from 'node:fs';
import {
  parseArgs, num, str, flag, csv, readJsonSafe, writeJson, writeText, ensureDir, rmrf,
  rel, usage, summary, slug, stamp, parseColor, toHex, contrast, wcagLevel, round, clamp,
} from './lib/core.mjs';
import { lintTokens } from './lib/scale.mjs';
import * as git from './lib/git.mjs';

const A = parseArgs();
const briefFile = A.brief ? readJsonSafe(path.resolve(String(A.brief))) : undefined;
const name = str(A.name, briefFile?.name ?? 'Northwind');
const locale = str(A.locale, briefFile?.locale ?? 'pt-BR');
const niche = str(A.niche, briefFile?.niche ?? 'saas');
const tone = str(A.tone, briefFile?.tone ?? 'premium');
const stack = str(A.stack, briefFile?.stack ?? 'static');
const seedStr = str(A.seed, briefFile?.seed ?? `${name}-${niche}-${tone}`);
const outDir = path.resolve(str(A.out, `./${slug(name)}`));
const sections = csv(str(A.sections, ''), String).length ? csv(str(A.sections), String)
  : (briefFile?.pages?.[0]?.sections ?? ['nav', 'hero', 'features', 'pricing', 'testimonials', 'faq', 'cta', 'contact', 'footer']);
const pages = briefFile?.pages ?? [{ path: '/', title: `${name}`, sections }];
if (!flag(A.noInit) && !fs.existsSync(outDir)) ensureDir(outDir);

/* ------------------------------------------------------------------ rng --- */
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rnd = mulberry32(hash(seedStr));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + rnd() * (b - a);

/* -------------------------------------------------------- design system --- */
const PALETTES = {
  premium: [['#0b0b0f', '#f7f6f3', '#e8e3da', '#b8894a'], ['#101014', '#fbfaf8', '#efe9e1', '#7c6a58'], ['#0d1117', '#f6f8fa', '#e6e9ee', '#2f6f5e']],
  professional: [['#0f172a', '#ffffff', '#f1f5f9', '#2563eb'], ['#111827', '#ffffff', '#f3f4f6', '#0ea5e9'], ['#1a1a1a', '#ffffff', '#f4f4f5', '#4338ca']],
  playful: [['#1b1b2f', '#fffdf7', '#ffe9d6', '#ff6b35'], ['#221c35', '#ffffff', '#f3e8ff', '#8b5cf6'], ['#10241f', '#f7fffb', '#d9f5e9', '#10b981']],
  technical: [['#0a0e14', '#ffffff', '#eef2f7', '#00b3a4'], ['#0f1115', '#f8fafc', '#e2e8f0', '#6366f1']],
};
const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 });
/** Nudge a colour until it is readable on EVERY background it can sit on. */
const balancedText = (color, backgrounds, minRatio = 4.5) => {
  const bgs = (Array.isArray(backgrounds) ? backgrounds : [backgrounds]).map((b) => parseColor(b));
  let c = parseColor(color); let guard = 0;
  const worst = () => Math.min(...bgs.map((b) => contrast(c, b)));
  while (worst() < minRatio && guard++ < 90) {
    const shift = bgs.every((b) => (b.r + b.g + b.b) / 3 > 128) ? -5 : 5;
    c = { r: clamp(c.r + shift, 0, 255), g: clamp(c.g + shift, 0, 255), b: clamp(c.b + shift, 0, 255), a: 1 };
  }
  return toHex(c);
};
/** Best ink for a given background among the safe candidates. */
const bestInkOn = (bg) => ['#ffffff', '#f8fafc', '#0b0b0f', '#111318'].reduce((best, cand) => (contrast(cand, bg) > contrast(best, bg) ? cand : best), '#ffffff');
function designSystem() {
  const [inkRaw, surface, surfaceAlt, accentRaw] = pick(PALETTES[tone] ?? PALETTES.professional);
  const ink = balancedText(inkRaw, [surface, surfaceAlt], 7);
  const accent = balancedText(accentRaw, [surface, surfaceAlt], 4.5);
  const accentInk = bestInkOn(accent);
  const muted = balancedText(toHex(mix(parseColor(ink), parseColor(surface), 0.62)), [surface, surfaceAlt], 4.5);
  const typeBase = pick([16, 17, 18]);
  const ratio = tone === 'premium' ? 1.28 : tone === 'playful' ? 1.32 : 1.24;
  const step = (n) => Math.round(typeBase * ratio ** n);
  return {
    seed: seedStr,
    colors: { ink, surface, surfaceAlt, muted, border: surfaceAlt, accent, accentInk },
    type: {
      bodyFamily: pick(['"Inter"', '"IBM Plex Sans"', '"Manrope"']), displayFamily: pick(['"Bricolage Grotesque"', '"Inter"', '"Sora"']),
      sizes: { xs: step(-1), sm: step(0), base: step(0), lg: step(1), h3: step(2), h2: step(3), h1: step(5) },
      ratio, base: typeBase,
    },
    space: [4, 8, 12, 16, 24, 32, 48, 64, 96, 128],
    radius: { sm: 8, md: 14, lg: 22, pill: 999 },
    shadow: { sm: '0 1px 2px rgba(16,18,24,.06), 0 1px 3px rgba(16,18,24,.08)', md: '0 10px 30px rgba(16,18,24,.10)', lg: '0 30px 80px rgba(16,18,24,.16)' },
    layout: { max: 1200, gutter: 24, measure: 68 },
    motion: { fast: 150, base: 250, slow: 420, ease: 'cubic-bezier(.2,.7,.2,1)' },
  };
}
const T = designSystem();

/* ----------------------------------------------------------------- copy --- */
const COPY = {
  'pt-BR': {
    nav: { links: ['Recursos', 'Preços', 'Casos', 'FAQ'], cta: 'Começar agora' },
    hero: {
      eyebrow: ['Novo', 'Versão 2.0', 'Feito para equipes'],
      h1: [`${name} resolve o trabalho pesado por você`, `Menos planilha, mais decisão`, `A operação inteira em um lugar só`],
      sub: [`Organize, automatize e acompanhe tudo em uma interface que a sua equipe entende no primeiro dia.`, `Feito para times pequenos que precisam de resultado grande — sem consultoria, sem migração dolorosa.`],
      cta: ['Criar conta grátis', 'Testar grátis por 14 dias'], secondary: ['Ver demonstração', 'Falar com vendas'],
    },
    features: {
      title: ['Tudo que você precisa', 'Feito para o dia a dia'],
      items: [
        ['Visão única', 'Todos os números importantes em um painel que carrega em menos de um segundo.'],
        ['Automação simples', 'Regras claras que rodam sozinhas e avisam quando algo sai do trilho.'],
        ['Colaboração real', 'Comentários, menções e histórico — sem prints no WhatsApp.'],
        ['Relatórios honestos', 'Exporte em CSV, agende por e-mail ou conecte na sua ferramenta.'],
        ['Segurança séria', 'Permissões por papel, registro de auditoria e backups diários.'],
        ['Integrações', 'Conecte o que você já usa em poucos minutos, sem código.'],
      ],
    },
    pricing: {
      title: ['Planos claros', 'Preço sem surpresa'],
      tiers: [['Essencial', 'R$ 0', 'até 3 usuários', ['Painel completo', 'Exportação CSV', 'Suporte por e-mail']], ['Pro', 'R$ 79', 'por usuário/mês', ['Tudo do Essencial', 'Automações', 'Integrações', 'Relatórios agendados']], ['Empresa', 'Fale conosco', 'sob medida', ['SSO e auditoria', 'SLA dedicado', 'Onboarding assistido']]],
      cta: 'Escolher plano',
    },
    testimonials: { title: 'Quem usa, conta', items: [['Ana Ribeiro', 'Operações, Vento Sul', 'Cortamos 6 horas por semana de conferência manual no primeiro mês.'], ['Diego Matos', 'Fundador, Casa Ferro', 'A equipe entendeu sem treinamento. Isso nunca aconteceu com outro sistema.'], ['Renata Lima', 'Financeiro, Aurora', 'Fechamos o mês em dois dias em vez de duas semanas.']] },
    faq: { title: 'Perguntas frequentes', items: [['Preciso instalar algo?', 'Não. Funciona no navegador, inclusive no celular.'], ['Como funciona o teste?', '14 dias completos, sem cartão e sem limite de recursos.'], ['Consigo exportar meus dados?', 'Sim, a qualquer momento, em CSV e via API.'], ['Vocês integram com o que eu uso?', 'Temos integrações prontas e uma API aberta para o resto.']] },
    cta: { title: 'Comece hoje e veja a diferença na primeira semana', sub: 'Sem contrato longo. Cancele quando quiser.', button: 'Criar conta grátis' },
    contact: { title: 'Fale com a gente', sub: 'Respondemos em até um dia útil.', fields: { name: 'Nome', email: 'E-mail', message: 'Mensagem' }, submit: 'Enviar mensagem', ok: 'Recebemos sua mensagem. Obrigado!' },
    footer: { blurb: 'Software para equipes que preferem decidir rápido.', columns: [['Produto', ['Recursos', 'Preços', 'Integrações']], ['Empresa', ['Sobre', 'Contato', 'Carreiras']], ['Legal', ['Privacidade', 'Termos']]], legal: `© ${new Date().getFullYear()} ${name}. Todos os direitos reservados.` },
    notFound: { title: 'Página não encontrada', sub: 'O endereço pode ter mudado ou nunca existiu.', button: 'Voltar ao início' },
    empty: { title: 'Nada por aqui ainda', sub: 'Quando você criar o primeiro item, ele aparece nesta lista.', button: 'Criar o primeiro' },
  },
  en: {
    nav: { links: ['Features', 'Pricing', 'Customers', 'FAQ'], cta: 'Get started' },
    hero: { eyebrow: ['New', 'Version 2.0', 'Built for teams'], h1: [`${name} does the heavy lifting`, `Less spreadsheet, more decisions`, `Your whole operation in one place`], sub: ['Organise, automate and track everything in an interface your team gets on day one.', 'Built for small teams that need big results — no consultants, no painful migration.'], cta: ['Start free', 'Try free for 14 days'], secondary: ['Watch the demo', 'Talk to sales'] },
    features: { title: ['Everything you need', 'Built for real days'], items: [['One view', 'Every number that matters on a dashboard that loads in under a second.'], ['Simple automation', 'Plain rules that run themselves and tell you when something drifts.'], ['Real collaboration', 'Comments, mentions and history — no screenshots in chat.'], ['Honest reporting', 'Export CSV, schedule by email, or pipe it into your own tools.'], ['Serious security', 'Role permissions, audit log and daily backups.'], ['Integrations', 'Connect what you already use in minutes, no code.']] },
    pricing: { title: ['Clear plans', 'No surprise pricing'], tiers: [['Starter', '$0', 'up to 3 users', ['Full dashboard', 'CSV export', 'Email support']], ['Pro', '$19', 'per user/month', ['Everything in Starter', 'Automations', 'Integrations', 'Scheduled reports']], ['Business', 'Talk to us', 'custom', ['SSO and audit', 'Dedicated SLA', 'Assisted onboarding']]], cta: 'Choose plan' },
    testimonials: { title: 'What customers say', items: [['Ana Ribeiro', 'Ops, Vento Sul', 'We cut six hours of manual checking in the first month.'], ['Diego Matos', 'Founder, Casa Ferro', 'The team understood it with no training. That never happened before.'], ['Renata Lima', 'Finance, Aurora', 'We close the month in two days instead of two weeks.']] },
    faq: { title: 'Frequently asked', items: [['Do I install anything?', 'No. It runs in the browser, phone included.'], ['How does the trial work?', '14 full days, no card, no feature limits.'], ['Can I export my data?', 'Yes, any time, as CSV or through the API.'], ['Do you integrate with my stack?', 'Ready-made integrations plus an open API for the rest.']] },
    cta: { title: 'Start today and see the difference this week', sub: 'No long contracts. Cancel whenever.', button: 'Start free' },
    contact: { title: 'Talk to us', sub: 'We reply within one business day.', fields: { name: 'Name', email: 'Email', message: 'Message' }, submit: 'Send message', ok: 'We got your message. Thank you!' },
    footer: { blurb: 'Software for teams that prefer deciding fast.', columns: [['Product', ['Features', 'Pricing', 'Integrations']], ['Company', ['About', 'Contact', 'Careers']], ['Legal', ['Privacy', 'Terms']]], legal: `© ${new Date().getFullYear()} ${name}. All rights reserved.` },
    notFound: { title: 'Page not found', sub: 'The address may have changed or never existed.', button: 'Back home' },
    empty: { title: 'Nothing here yet', sub: 'Your first item will show up in this list.', button: 'Create the first one' },
  },
};
const C = COPY[locale.startsWith('pt') ? 'pt-BR' : 'en'];
const assetRef = (kind, extra = '') => `assets/${kind}${extra ? `-${extra}` : ''}.svg`;

/* ------------------------------------------------------------------ IR ---- */
const el = (tag, attrs = {}, children = []) => ({ tag, attrs, children: children.filter((c) => c !== undefined && c !== null && c !== false) });
const txt = (s) => String(s);
const svgIcon = (i) => {
  const shapes = ['<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>', '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12h8M12 8v8"/>', '<path d="M4 18 12 4l8 14z"/>', '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/>', '<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M3 10h18"/>', '<path d="M12 3v18M3 12h18"/>'];
  return { tag: 'span', attrs: { class: 'icon', 'aria-hidden': 'true' }, children: [{ tag: 'svg', attrs: { viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', inner: shapes[i % shapes.length] }, children: [] }] };
};

const BLOCKS = {
  nav: () => el('header', { class: 'site-nav', id: 'top' }, [
    el('div', { class: 'container nav-inner' }, [
      el('a', { class: 'brand', href: '#top' }, [el('img', { src: assetRef('logo'), alt: name, width: '32', height: '32' }), el('span', {}, [txt(name)])]),
      el('nav', { class: 'nav-links', 'aria-label': locale.startsWith('pt') ? 'principal' : 'main' }, C.nav.links.map((l, i) => el('a', { href: `#${slug(l)}` }, [txt(l)]))),
      el('a', { class: 'btn btn-primary nav-cta', href: '#contact' }, [txt(C.nav.cta)]),
      el('button', { class: 'nav-toggle', type: 'button', 'aria-label': locale.startsWith('pt') ? 'Abrir menu' : 'Open menu', 'aria-expanded': 'false' }, [el('span', { class: 'nav-toggle-bar' }, [])]),
    ]),
  ]),
  hero: () => el('section', { class: 'hero', 'aria-labelledby': 'hero-title' }, [
    el('div', { class: 'container hero-inner' }, [
      el('div', { class: 'hero-copy' }, [
        el('p', { class: 'eyebrow' }, [txt(pick(C.hero.eyebrow))]),
        el('h1', { id: 'hero-title', class: 'h1' }, [txt(pick(C.hero.h1))]),
        el('p', { class: 'lead' }, [txt(pick(C.hero.sub))]),
        el('div', { class: 'hero-actions' }, [
          el('a', { class: 'btn btn-primary', href: '#contact' }, [txt(pick(C.hero.cta))]),
          el('a', { class: 'btn btn-ghost', href: '#features' }, [txt(pick(C.hero.secondary))]),
        ]),
        el('ul', { class: 'hero-proof' }, [0, 1, 2].map((i) => el('li', {}, [txt(`${round(between(2, 9), 0) * 100}+`), el('span', {}, [txt(locale.startsWith('pt') ? 'equipes ativas' : 'active teams')])]))),
      ]),
      el('div', { class: 'hero-art' }, [el('img', { src: assetRef('hero-art'), alt: '', width: '960', height: '576', loading: 'eager' })]),
    ]),
  ]),
  features: () => el('section', { class: 'section features', id: 'features' }, [
    el('div', { class: 'container' }, [
      el('h2', { class: 'h2' }, [txt(pick(C.features.title))]),
      el('ul', { class: 'card-grid' }, C.features.items.slice(0, 6).map(([t, d], i) => el('li', { class: 'card' }, [svgIcon(i), el('h3', { class: 'h3' }, [txt(t)]), el('p', {}, [txt(d)])]))),
    ]),
  ]),
  pricing: () => el('section', { class: 'section pricing', id: 'pricing' }, [
    el('div', { class: 'container' }, [
      el('h2', { class: 'h2' }, [txt(pick(C.pricing.title))]),
      el('div', { class: 'tier-grid' }, C.pricing.tiers.map(([t, price, per, feats], i) => el('div', { class: `tier${i === 1 ? ' tier-featured' : ''}` }, [
        el('h3', { class: 'h3' }, [txt(t)]),
        el('p', { class: 'price' }, [txt(price), el('span', {}, [txt(` ${per}`)])]),
        el('ul', { class: 'tier-list' }, feats.map((f) => el('li', {}, [txt(f)]))),
        el('a', { class: `btn ${i === 1 ? 'btn-primary' : 'btn-ghost'}`, href: '#contact' }, [txt(C.pricing.cta)]),
      ]))),
    ]),
  ]),
  testimonials: () => el('section', { class: 'section testimonials', id: 'customers' }, [
    el('div', { class: 'container' }, [
      el('h2', { class: 'h2' }, [txt(C.testimonials.title)]),
      el('div', { class: 'quote-grid' }, C.testimonials.items.map(([who, role, quote], i) => el('figure', { class: 'quote' }, [
        el('blockquote', {}, [txt(`“${quote}”`)]),
        el('figcaption', {}, [el('img', { src: assetRef('avatar', String(i + 1)), alt: '', width: '48', height: '48', loading: 'lazy' }), el('span', {}, [el('strong', {}, [txt(who)]), el('em', {}, [txt(role)])])]),
      ]))),
    ]),
  ]),
  faq: () => el('section', { class: 'section faq', id: 'faq' }, [
    el('div', { class: 'container narrow' }, [
      el('h2', { class: 'h2' }, [txt(C.faq.title)]),
      ...C.faq.items.map(([q, a], i) => el('details', { class: 'faq-item', ...(i === 0 ? { open: 'open' } : {}) }, [
        el('summary', {}, [txt(q)]), el('div', { class: 'faq-body' }, [el('p', {}, [txt(a)])]),
      ])),
    ]),
  ]),
  cta: () => el('section', { class: 'band', 'aria-labelledby': 'cta-title' }, [
    el('div', { class: 'container band-inner' }, [
      el('h2', { class: 'h2', id: 'cta-title' }, [txt(C.cta.title)]),
      el('p', { class: 'lead' }, [txt(C.cta.sub)]),
      el('a', { class: 'btn btn-primary', href: '#contact' }, [txt(C.cta.button)]),
    ]),
  ]),
  contact: () => el('section', { class: 'section contact', id: 'contact' }, [
    el('div', { class: 'container narrow' }, [
      el('h2', { class: 'h2' }, [txt(C.contact.title)]),
      el('p', { class: 'lead' }, [txt(C.contact.sub)]),
      el('form', { class: 'form', novalidate: 'novalidate', 'data-form': 'contact' }, [
        ...[['name', 'text'], ['email', 'email']].map(([f, type]) => el('label', { class: 'field' }, [el('span', {}, [txt(C.contact.fields[f])]), el('input', { type, name: f, required: 'required', autocomplete: f === 'email' ? 'email' : 'name' })])),
        el('label', { class: 'field' }, [el('span', {}, [txt(C.contact.fields.message)]), el('textarea', { name: 'message', rows: '5', required: 'required' })]),
        el('button', { class: 'btn btn-primary', type: 'submit' }, [txt(C.contact.submit)]),
        el('p', { class: 'form-status', role: 'status', hidden: 'hidden' }, [txt(C.contact.ok)]),
      ]),
    ]),
  ]),
  footer: () => {
    const cols = C.footer.columns.map(([title, items]) => el('div', { class: 'footer-col' }, [
      el('h3', {}, [txt(title)]),
      el('ul', {}, items.map((item) => el('li', {}, [el('a', { href: '#top' }, [txt(item)])]))),
    ]));
    return el('footer', { class: 'site-footer' }, [
      el('div', { class: 'container footer-inner' }, [
        el('div', { class: 'footer-brand' }, [el('img', { src: assetRef('logo'), alt: '', width: '28', height: '28', loading: 'lazy' }), el('p', {}, [txt(C.footer.blurb)])]),
        ...cols,
      ]),
      el('div', { class: 'container footer-legal' }, [el('p', {}, [txt(C.footer.legal)])]),
    ]);
  },
  notFound: () => el('section', { class: 'section not-found' }, [
    el('div', { class: 'container narrow' }, [el('h1', { class: 'h1' }, [txt(C.notFound.title)]), el('p', { class: 'lead' }, [txt(C.notFound.sub)]), el('a', { class: 'btn btn-primary', href: '/' }, [txt(C.notFound.button)])]),
  ]),
  empty: () => el('section', { class: 'section empty' }, [
    el('div', { class: 'container narrow' }, [el('img', { src: assetRef('pattern'), alt: '', width: '160', height: '160', loading: 'lazy' }), el('h2', { class: 'h2' }, [txt(C.empty.title)]), el('p', {}, [txt(C.empty.sub)]), el('button', { class: 'btn btn-primary', type: 'button' }, [txt(C.empty.button)])]),
  ]),
};

/* ------------------------------------------------------------ renderers --- */
const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source']);
const ATTR_ALIAS = { class: 'class', novalidate: 'novalidate' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function toHtml(node, indent = 0) {
  if (typeof node === 'string') return ' '.repeat(indent) + esc(node);
  const pad = ' '.repeat(indent);
  const attrs = Object.entries(node.attrs ?? {}).filter(([k]) => k !== 'inner')
    .map(([k, v]) => v === true ? ` ${k}` : v === false || v === undefined ? '' : ` ${k}="${esc(v)}"`).join('');
  if (node.attrs?.inner) return `${pad}<${node.tag}${attrs}>${node.attrs.inner}</${node.tag}>`;
  if (VOID.has(node.tag) || !node.children?.length) return `${pad}<${node.tag}${attrs}${VOID.has(node.tag) ? '' : '>' + `</${node.tag}>`}`;
  const inner = node.children.map((c) => toHtml(c, indent + 2)).join('\n');
  const inline = node.children.every((c) => typeof c === 'string');
  return inline ? `${pad}<${node.tag}${attrs}>${node.children.map(esc).join('')}</${node.tag}>`
    : `${pad}<${node.tag}${attrs}>\n${inner}\n${pad}</${node.tag}>`;
}
function toJsx(node, indent = 0) {
  if (typeof node === 'string') return ' '.repeat(indent) + `{${JSON.stringify(node)}}`;
  const pad = ' '.repeat(indent);
  const attrs = Object.entries(node.attrs ?? {}).filter(([k]) => k !== 'inner')
    .map(([k, v]) => {
      const key = k === 'class' ? 'className' : k === 'for' ? 'htmlFor' : k;
      if (v === true) return ` ${key}`;
      if (v === false || v === undefined) return '';
      return ` ${key}=${JSON.stringify(v)}`;
    }).join('');
  if (node.attrs?.inner) return `${pad}<${node.tag}${attrs} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(node.attrs.inner)} }} />`;
  if (VOID.has(node.tag)) return `${pad}<${node.tag}${attrs} />`;
  if (!node.children?.length) return `${pad}<${node.tag}${attrs} />`;
  const inner = node.children.map((c) => toJsx(c, indent + 2)).join('\n');
  return `${pad}<${node.tag}${attrs}>\n${inner}\n${pad}</${node.tag}>`;
}

/* ------------------------------------------------------------------ css --- */
const cssName = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
function tokensCss() {
  const t = T;
  return `/* generated by fidelity/gen.mjs — design system (coherence-linted) */
:root {
  /* palette (WCAG-checked) */
${Object.entries(t.colors).map(([k, v]) => `  --color-${cssName(k)}: ${v};`).join('\n')}
  /* type scale: base ${t.base}px, ratio ${t.ratio} */
${Object.entries(t.type.sizes).map(([k, v]) => `  --size-${k}: ${clamp(v, 11, 96)}px;`).join('\n')}
  --font-body: ${t.type.bodyFamily}, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-display: ${t.type.displayFamily}, var(--font-body);
  --leading-tight: 1.06; --leading-snug: 1.25; --leading-body: 1.6;
  /* spacing: ${t.space.length} steps on the 4px grid */
${t.space.map((v, i) => `  --sp-${i + 1}: ${v}px;`).join('\n')}
  --radius-sm: ${t.radius.sm}px; --radius-md: ${t.radius.md}px; --radius-lg: ${t.radius.lg}px; --radius-pill: ${t.radius.pill}px;
  --shadow-sm: ${t.shadow.sm}; --shadow-md: ${t.shadow.md}; --shadow-lg: ${t.shadow.lg};
  --max: ${t.layout.max}px; --gutter: ${t.layout.gutter}px; --measure: ${t.layout.measure}ch;
  --fast: ${t.motion.fast}ms; --base: ${t.motion.base}ms; --slow: ${t.motion.slow}ms; --ease: ${t.motion.ease};
  --bp-md: 760px; --bp-lg: 1024px;
}
`;
}
function layoutCss() {
  return `/* generated by fidelity/gen.mjs — layout + components */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; font-family: var(--font-body); font-size: var(--size-base); line-height: var(--leading-body); color: var(--color-ink); background: var(--color-surface); }
img, svg, video { max-width: 100%; height: auto; display: block; }
a { color: inherit; }
h1, h2, h3 { font-family: var(--font-display); line-height: var(--leading-tight); letter-spacing: -0.015em; margin: 0 0 var(--sp-4); }
.h1 { font-size: clamp(${T.type.sizes.h1}px, ${round(T.type.sizes.h1 / 13.66, 2)}vw + 1rem, ${Math.round(T.type.sizes.h1 * 1.7)}px); }
.h2 { font-size: clamp(${T.type.sizes.h2}px, 2.2vw + 1rem, ${Math.round(T.type.sizes.h2 * 1.5)}px); }
.h3 { font-size: var(--size-h3); }
p { margin: 0 0 var(--sp-3); }
.lead { font-size: var(--size-lg); color: var(--color-muted); max-width: var(--measure); }
.container { width: 100%; max-width: var(--max); margin-inline: auto; padding-inline: var(--gutter); }
.narrow { max-width: calc(var(--measure) * 2); }
.section { padding-block: clamp(var(--sp-7), 8vw, var(--sp-9)); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2); padding: 12px 20px; border-radius: var(--radius-pill); border: 1px solid transparent; font-weight: 600; text-decoration: none; cursor: pointer; transition: transform var(--fast) var(--ease), background var(--fast) var(--ease); }
.btn:hover { transform: translateY(-1px); }
.btn-primary { background: var(--color-accent); color: var(--color-accent-ink); }
.btn-ghost { border-color: var(--color-border); color: var(--color-ink); background: transparent; }
.icon { color: var(--color-accent); display: inline-flex; }
:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; border-radius: var(--radius-sm); }
.site-nav { position: sticky; top: 0; z-index: 20; backdrop-filter: blur(10px); background: color-mix(in srgb, var(--color-surface) 88%, transparent); border-bottom: 1px solid var(--color-border); }
.nav-inner { display: flex; align-items: center; gap: var(--sp-5); min-height: 68px; }
.brand { display: inline-flex; align-items: center; gap: var(--sp-2); font-weight: 700; text-decoration: none; font-family: var(--font-display); }
.nav-links { display: none; gap: var(--sp-5); margin-inline-start: auto; }
.nav-links a { text-decoration: none; color: var(--color-muted); }
.nav-links a:hover { color: var(--color-ink); }
.nav-cta { margin-inline-start: auto; }
.nav-toggle { display: inline-flex; margin-inline-start: auto; background: none; border: 0; padding: var(--sp-2); cursor: pointer; }
.nav-toggle-bar { width: 22px; height: 2px; background: var(--color-ink); display: block; position: relative; }
.nav-toggle-bar::before, .nav-toggle-bar::after { content: ""; position: absolute; left: 0; width: 22px; height: 2px; background: var(--color-ink); }
.nav-toggle-bar::before { top: -7px; } .nav-toggle-bar::after { top: 7px; }
.hero { padding-block: clamp(var(--sp-7), 10vw, 140px); }
.hero-inner { display: grid; gap: var(--sp-7); align-items: center; }
.eyebrow { text-transform: uppercase; letter-spacing: .12em; font-size: var(--size-xs); color: var(--color-accent); font-weight: 600; }
.hero-actions { display: flex; flex-wrap: wrap; gap: var(--sp-3); margin-block: var(--sp-5); }
.hero-proof { display: flex; gap: var(--sp-6); list-style: none; padding: 0; margin: var(--sp-6) 0 0; }
.hero-proof strong, .hero-proof li > span { display: block; color: var(--color-muted); font-size: var(--size-sm); }
.hero-proof li { font-family: var(--font-display); font-size: var(--size-h3); }
.hero-art img { border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); }
.card-grid, .tier-grid, .quote-grid { display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.card { list-style: none; padding: var(--sp-5); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
.card h3 { margin-block: var(--sp-3) var(--sp-2); }
.card p, .quote blockquote, .tier-list, .faq-body p { color: var(--color-muted); }
.tier { padding: var(--sp-6); border: 1px solid var(--color-border); border-radius: var(--radius-lg); display: flex; flex-direction: column; gap: var(--sp-3); }
.tier-featured { border-color: var(--color-accent); box-shadow: var(--shadow-md); }
.price { font-family: var(--font-display); font-size: var(--size-h2); margin: 0; }
.price span { font-family: var(--font-body); font-size: var(--size-sm); color: var(--color-muted); }
.tier-list { list-style: none; padding: 0; margin: 0 0 auto; display: grid; gap: var(--sp-2); }
.tier-list li::before { content: "✓"; color: var(--color-accent); margin-inline-end: var(--sp-2); }
.quote { margin: 0; padding: var(--sp-5); border-radius: var(--radius-md); background: var(--color-surface-alt); }
.quote blockquote { margin: 0 0 var(--sp-4); font-size: var(--size-lg); }
.quote figcaption { display: flex; align-items: center; gap: var(--sp-3); }
.quote img { border-radius: var(--radius-pill); }
.quote strong { display: block; } .quote em { color: var(--color-muted); font-size: var(--size-sm); font-style: normal; }
.faq-item { border-bottom: 1px solid var(--color-border); padding-block: var(--sp-4); }
.faq-item summary { cursor: pointer; font-weight: 600; font-size: var(--size-lg); }
.band { background: var(--color-ink); color: var(--color-surface); padding-block: clamp(var(--sp-6), 7vw, var(--sp-8)); }
.band .lead { color: color-mix(in srgb, var(--color-surface) 78%, transparent); }
.band-inner { display: grid; gap: var(--sp-4); justify-items: start; }
.form { display: grid; gap: var(--sp-4); }
.field { display: grid; gap: var(--sp-2); font-weight: 600; }
.field input, .field textarea { font: inherit; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); }
.field input[aria-invalid="true"], .field textarea[aria-invalid="true"] { border-color: #c2410c; }
.form-status { color: var(--color-accent); font-weight: 600; }
.site-footer { border-top: 1px solid var(--color-border); padding-block: var(--sp-7) var(--sp-4); margin-top: var(--sp-8); }
.footer-inner { display: grid; gap: var(--sp-6); grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.footer-brand p { color: var(--color-muted); max-width: 34ch; }
.footer-col h3 { font-size: var(--size-sm); text-transform: uppercase; letter-spacing: .1em; color: var(--color-muted); }
.footer-col ul { list-style: none; padding: 0; display: grid; gap: var(--sp-2); }
.footer-col a { text-decoration: none; }
.footer-legal { border-top: 1px solid var(--color-border); margin-top: var(--sp-6); padding-top: var(--sp-4); color: var(--color-muted); font-size: var(--size-sm); }
[hidden] { display: none !important; }
@media (min-width: 760px) {
  .nav-links { display: flex; } .nav-toggle { display: none; }
  .nav-cta { margin-inline-start: 0; }
  .hero-inner { grid-template-columns: 1.05fr .95fr; }
  .band-inner { grid-template-columns: 1fr auto; align-items: center; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
`;
}
function mainJs() {
  return `// generated by fidelity/gen.mjs — progressive enhancement only
(() => {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      links.style.display = open ? '' : 'flex';
      links.style.flexDirection = 'column';
      links.style.position = 'absolute';
      links.style.insetInline = 'var(--gutter)';
      links.style.top = '68px';
      links.style.padding = 'var(--sp-4)';
      links.style.background = 'var(--color-surface)';
      links.style.border = '1px solid var(--color-border)';
      links.style.borderRadius = 'var(--radius-md)';
    });
  }
  const form = document.querySelector('[data-form="contact"]');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let ok = true;
      for (const field of form.querySelectorAll('input, textarea')) {
        const valid = field.checkValidity() && field.value.trim().length > 0;
        field.setAttribute('aria-invalid', String(!valid));
        if (!valid) ok = false;
      }
      if (!ok) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
      const status = form.querySelector('.form-status');
      status.hidden = false;
      form.querySelector('button[type="submit"]').disabled = true;
    });
  }
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.style.opacity = '1'; e.target.style.transform = 'none'; io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -10% 0px' });
    for (const s of document.querySelectorAll('.section, .card, .tier, .quote')) {
      s.style.opacity = '0'; s.style.transform = 'translateY(12px)';
      s.style.transition = 'opacity var(--slow) var(--ease), transform var(--slow) var(--ease)';
      io.observe(s);
    }
  }
})();
`;
}

/* ---------------------------------------------------------------- pages --- */
function htmlDoc({ title, description, body, is404 = false }) {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="${T.colors.surface}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<link rel="icon" href="assets/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="styles/tokens.css">
<link rel="stylesheet" href="styles/layout.css">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name, url: `https://${slug(name)}.example` })}</script>
</head>
<body${is404 ? ' class="is-404"' : ''}>
${body}
<script src="scripts/main.js" defer></script>
</body>
</html>
`;
}

function genStatic() {
  const assetsDir = path.join(outDir, 'assets');
  ensureDir(assetsDir); ensureDir(path.join(outDir, 'styles')); ensureDir(path.join(outDir, 'scripts'));
  writeText(path.join(outDir, 'styles/tokens.css'), tokensCss());
  writeText(path.join(outDir, 'styles/layout.css'), layoutCss());
  writeText(path.join(outDir, 'scripts/main.js'), mainJs());
  // internal SVG art (no external dependencies)
  const svg = (kind, extra, content) => writeText(path.join(assetsDir, `${kind}${extra ? `-${extra}` : ''}.svg`), content);
  svg('logo', '', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" role="img" aria-label="${esc(name)}"><rect width="48" height="48" rx="12" fill="${T.colors.accent}"/><path d="M14 30l10-14 10 14z" fill="${T.colors.accentInk}"/></svg>`);
  svg('hero-art', '', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 576" role="img" aria-label=""><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${T.colors.accent}"/><stop offset="1" stop-color="${T.colors.ink}"/></linearGradient></defs><rect width="960" height="576" fill="url(#g)"/><g fill="${T.colors.surface}" opacity=".14"><circle cx="180" cy="140" r="150"/><circle cx="760" cy="440" r="200"/></g><rect x="80" y="200" width="800" height="180" rx="24" fill="${T.colors.surface}" opacity=".18"/></svg>`);
  svg('pattern', '', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" role="img" aria-label=""><rect width="160" height="160" fill="${T.colors.surfaceAlt}"/><g fill="${T.colors.accent}" opacity=".35">${Array.from({ length: 9 }, (_, i) => `<circle cx="${20 + (i % 3) * 60}" cy="${20 + Math.floor(i / 3) * 60}" r="14"/>`).join('')}</g></svg>`);
  [1, 2, 3].forEach((i) => svg('avatar', String(i), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" role="img" aria-label=""><circle cx="24" cy="24" r="24" fill="${['#b8894a', '#2f6f5e', '#4338ca'][i - 1]}"/><text x="50%" y="56%" text-anchor="middle" dominant-baseline="middle" font-family="system-ui" font-size="18" fill="#fff">${['AR', 'DM', 'RL'][i - 1]}</text></svg>`));

  const written = [];
  for (const page of pages) {
    const body = (page.sections ?? sections).map((s) => toHtml(BLOCKS[s]?.() ?? el('section'), 2)).join('\n');
    const file = page.path === '/' ? 'index.html' : `${page.path.replace(/^\//, '').replace(/\/$/, '')}.html`;
    writeText(path.join(outDir, file), htmlDoc({ title: page.title ?? `${name} — ${C.hero.h1[0]}`, description: page.description ?? C.hero.sub[0], body }));
    written.push(file);
  }
  writeText(path.join(outDir, '404.html'), htmlDoc({ title: `404 — ${name}`, description: C.notFound.sub, body: toHtml(BLOCKS.notFound(), 2), is404: true }));
  written.push('404.html');
  const urls = written.filter((f) => f !== '404.html').map((f) => `  <url><loc>/${f === 'index.html' ? '' : f}</loc></url>`).join('\n');
  writeText(path.join(outDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  writeText(path.join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n`);
  return written;
}

function genReact() {
  ensureDir(path.join(outDir, 'src/components'));
  writeText(path.join(outDir, 'package.json'), JSON.stringify({
    name: slug(name), private: true, version: '0.1.0', type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview --port 4173' },
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
    devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.0' },
  }, null, 2) + '\n');
  writeText(path.join(outDir, 'vite.config.js'), `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], server: { port: 3000 } });\n`);
  writeText(path.join(outDir, 'index.html'), `<!doctype html>\n<html lang="${locale}">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>${esc(name)}</title>\n    <link rel="stylesheet" href="/src/styles.css" />\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`);
  writeText(path.join(outDir, 'src/styles.css'), tokensCss() + '\n' + layoutCss());
  writeText(path.join(outDir, 'src/main.jsx'), `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n`);
  const comps = [];
  for (const s of sections) {
    const comp = s.charAt(0).toUpperCase() + s.slice(1);
    const ir = BLOCKS[s]?.();
    if (!ir) continue;
    writeText(path.join(outDir, `src/components/${comp}.jsx`), `import React from 'react';\n\nexport default function ${comp}() {\n  return (\n${toJsx(ir, 4)}\n  );\n}\n`);
    comps.push({ comp, file: `./components/${comp}.jsx` });
  }
  writeText(path.join(outDir, 'src/App.jsx'), `import React, { useEffect, useState } from 'react';\n${comps.map((c) => `import ${c.comp} from '${c.file}';`).join('\n')}\nimport './enhance.js';\n\nconst ROUTES = {\n  '/': () => <>\n${comps.map((c) => `    <${c.comp} />`).join('\n')}\n  </>,\n  '/404': () => <NotFound />,\n};\n\nfunction NotFound() {\n  return (\n    <section className="section not-found">\n      <div className="container narrow">\n        <h1 className="h1">${C.notFound.title}</h1>\n        <p className="lead">${C.notFound.sub}</p>\n        <a className="btn btn-primary" href="/">${C.notFound.button}</a>\n      </div>\n    </section>\n  );\n}\n\nexport default function App() {\n  const [path, setPath] = useState(window.location.pathname);\n  useEffect(() => {\n    const onPop = () => setPath(window.location.pathname);\n    window.addEventListener('popstate', onPop);\n    return () => window.removeEventListener('popstate', onPop);\n  }, []);\n  const Page = ROUTES[path] ?? ROUTES['/404'];\n  return <Page />;\n}\n`);
  writeText(path.join(outDir, 'src/enhance.js'), mainJs().replace(/^\/\/.*$/m, '// progressive enhancement, run after mount'));
  return ['package.json', 'vite.config.js', 'index.html', 'src/main.jsx', 'src/App.jsx', 'src/styles.css', 'src/enhance.js', ...comps.map((c) => `src/components/${c.comp}.jsx`)];
}

/* ----------------------------------------------------------------- main --- */
if (fs.existsSync(outDir) && !flag(A.force) && fs.readdirSync(outDir).length && !flag(A.noInit)) {
  console.error(`✗ ${outDir} already exists and is not empty (use --force to overwrite)`);
  process.exit(1);
}
ensureDir(outDir);
const written = stack === 'react' ? genReact() : genStatic();

const lint = lintTokens({
  colors: Object.entries(T.colors).map(([k, v]) => ({ name: k, hex: /^#/.test(v) ? v : '#000000' })),
  fonts: [{ role: 'body', size: `${T.type.base}px` }, { role: 'h3', size: `${T.type.sizes.h3}px` }, { role: 'h2', size: `${T.type.sizes.h2}px` }, { role: 'h1', size: `${T.type.sizes.h1}px` }],
  space: { unit: 4, steps: T.space },
  radius: Object.entries(T.radius).map(([k, v]) => ({ name: k, px: v })),
}, { gridUnit: 4 });
// The design system is validated before a single byte is written: a palette that
// cannot be read on one of its own surfaces is a bug, not a warning.
const lintErrors = lint.filter((i) => i.level === 'error');
if (lintErrors.length) {
  for (const i of lintErrors) console.error(`✗ lint ${i.target}: ${i.msg}`);
  console.error(`✗ generated palette failed the coherence lint (${lintErrors.length} error(s)) — adjust PALETTES["${tone}"]`);
  process.exit(1);
}

const site = { generatedAt: stamp(), generator: 'gen.mjs', brief: { name, locale, niche, tone, seed: seedStr, stack }, design: T, pages: pages.map((p) => ({ path: p.path, sections: p.sections ?? sections })), files: written, lint };
writeJson(path.join(outDir, 'site.json'), site);

const contrastPairs = [['ink', 'surface'], ['ink', 'surfaceAlt'], ['muted', 'surface'], ['muted', 'surfaceAlt'], ['accentInk', 'accent']];
const contrastChecks = contrastPairs.map(([a, b]) => ({ pair: `${a}/${b}`, ratio: contrast(parseColor(T.colors[a]), parseColor(T.colors[b])), level: wcagLevel(contrast(parseColor(T.colors[a]), parseColor(T.colors[b]))) }));

const validation = {
  url: str(A.url, 'http://localhost:3000'),
  widths: [390, 760, 1024, 1440],
  height: 900, screenshot: true, retries: 1,
  reducedMotion: false,
  passes: [{ name: 'default' }],
  elementShots: { nav: '.site-nav', hero: '.hero', features: '.features' },
  checks: [
    { type: 'a11y', rules: ['img-alt', 'button-name', 'html-lang', 'title', 'h1-once'] },
    { type: 'exists', selector: 'main, .hero' },
    { type: 'exists', selector: 'h1', from: 'hero-title' },
    { type: 'visible', selector: '.btn-primary', from: 'primary-cta' },
    { type: 'count', selector: 'nav.nav-links a', equals: 4, width: 1440, from: 'nav-links' },
    { type: 'contrast', selector: '.lead', minRatio: 4.5, from: 'body-muted' },
    { type: 'contrast', selector: '.quote blockquote', minRatio: 4.5, from: 'quote-on-surface-alt' },
    { type: 'contrast', selector: '.eyebrow', minRatio: 4.5, from: 'accent-as-text' },
    { type: 'boundingBox', selector: '.hero', width: 1440, prop: 'width', minPx: 1000, from: 'hero-width' },
    { type: 'boundingBox', selector: '.hero', width: 390, prop: 'width', minPx: 300, maxPx: 420, from: 'hero-width-mobile' },
    { type: 'style', selector: 'body', prop: 'font-size', equals: `${T.type.base}px`, from: 'base-size' },
    { type: 'noRequest', denyHosts: ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'], from: 'stays-dependency-free' },
    ...contrastPairs.map(([a, b]) => ({ type: 'value', js: `getComputedStyle(document.documentElement).getPropertyValue('--color-${cssName(a)}').trim()`, equals: T.colors[a], from: `token-${a}` })),
    { type: 'count', selector: '.tier', equals: 3, from: 'pricing-tiers' },
    { type: 'count', selector: '.card', min: 3, from: 'feature-cards' },
    { type: 'font', family: T.type.bodyFamily.replace(/"/g, ''), weight: 400, from: 'body-font' },
    { type: 'scrollHeight', width: 1440, approxPx: 3200, tolerancePx: 2600, from: 'sane-page-height' },
    // Interactions: the page must behave, not just render. These are state transitions
    // (hover → restore, tab → focus ring, scroll → sticky), so a static screenshot
    // cannot replace them.
    { type: 'hover', selector: '.btn-primary', width: 1440, prop: 'transform', requireChange: true, settle: 260, from: 'cta-hover-lift' },
    { type: 'focus', selector: '.nav-links a', width: 1440, via: 'tab', prop: 'outlineStyle', equals: 'solid', from: 'focus-ring' },
    { type: 'scroll', selector: 'header.site-nav', width: 1440, scrollTo: 800, position: 'sticky', viewportTop: 0, from: 'sticky-nav' },
  ],
};
writeJson(path.join(outDir, 'validation.json'), validation);
writeText(path.join(outDir, 'README.md'), `# ${name}

Generated by the **fidelity** skill's generator mode (\`gen.mjs\`, stack: ${stack}, seed: \`${seedStr}\`).

- Design system + block parameters: \`site.json\` (machine-readable)
- Tokens: ${stack === 'react' ? '`src/styles.css`' : '`styles/tokens.css`'}
- Gates: \`node validate.mjs --checks validation.json --out report\` then \`budgets.mjs\`, then \`verify.mjs gate\`

Coherence lint: ${lint.length ? lint.map((i) => `${i.level}:${i.target} ${i.msg}`).join(' · ') : 'clean'}.
Contrast: ${contrastChecks.map((c) => `${c.pair} ${c.ratio}:1 ${c.level}`).join(' · ')}.
`);

// Every project is a repo: a bad fix cycle is `project.mjs rollback --to <tag> --yes`,
// not a manual revert. `--no-git` opts out (e.g. generating into an existing repo).
writeText(path.join(outDir, '.gitignore'), `# generated by fidelity
node_modules/
dist/
report/
visual-report/
budgets/
import/
judge/*.png
*.log
.DS_Store
`);
let repo;
if (!flag(A.noGit)) {
  repo = git.init(outDir, { commitMessage: `chore: generate ${name}` });
  if (!repo.ok) console.log(`  ! git: ${repo.reason ?? repo.error ?? 'not initialized'}`);
}

summary('gen', {
  out: rel(outDir, process.cwd()), stack, pages: written.length, sections: sections.length,
  palette: T.colors.accent, typeRatio: T.type.ratio, lintIssues: lint.filter((i) => i.level !== 'info').length,
  contrast: Object.fromEntries(contrastChecks.map((c) => [c.pair, `${c.ratio}:1 ${c.level}`])),
  git: repo?.ok ? repo.commit ?? repo.skipped : 'off',
  next: stack === 'react' ? 'npm install && npm run dev' : `npx serve ${rel(outDir, process.cwd())} -l 3000`,
});
for (const i of lint) if (i.level !== 'info') console.log(`  ${i.level === 'error' ? '✗' : '!'} ${i.target}: ${i.msg}`);
