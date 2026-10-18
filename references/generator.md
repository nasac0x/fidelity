# Generator mode — brief → design system → site

No reference? Then the reference is a **system**: one coherent design token set, nine
blocks, one copy deck, generated once and then held to the same gates as a clone.

```powershell
$F = "$HOME/.agents/skills/fidelity/scripts"
node "$F/gen.mjs" --name "Northwind" --niche saas --locale pt-BR --out "C:\Users\victo\Desktop\PROJETOS\northwind"
node "$F/gen.mjs" --brief brief.json --stack react --seed 42 --out ... --force
```

`--out` must not exist (or be empty) unless `--force`. Nothing is downloaded; every
image is an inline SVG generated from the token set.

## Brief

```jsonc
{
  "name": "Northwind",
  "locale": "pt-BR",          // pt-BR | en
  "niche": "saas",            // free text — flavours the copy, never the layout
  "tone": "premium",          // premium | professional | playful | technical
  "seed": "northwind-saas",   // deterministic; same seed ⇒ same site
  "stack": "static",          // static | react
  "pages": [
    { "path": "/",     "title": "Northwind", "sections": ["nav","hero","features","pricing","testimonials","faq","cta","contact","footer"] },
    { "path": "/precos", "title": "Preços",  "sections": ["nav","pricing","faq","footer"] }
  ]
}
```

CLI flags win over the file. Without `pages`, one page with the default nine sections.
Available sections: `nav` `hero` `features` `pricing` `testimonials` `faq` `cta`
`contact` `footer` (plus `notFound` and `empty` blocks written as `404.html`/states).

## What it decides (and why it is not random)

| Decision | Rule |
| --- | --- |
| Accent | picked by **chroma** from the tone palette, not by hue preference |
| `surface-alt` | a neutral shift of `surface`, never a tinted grey |
| `muted` | `mix()` solved so it passes on **both** surfaces (`balancedText`) |
| `inverse` / `accentInk` | chosen by measured contrast against `accent` |
| Type scale | ratio by tone: premium 1.28, playful 1.32, else 1.24 |
| Space | 4px grid, geometric steps |
| Radius | by size: `sm 8`, `md 14`, `lg 22`, `pill 999` |
| Motion | `IntersectionObserver` fade-up, disabled under `prefers-reduced-motion` |

`lintTokens` runs **before writing**. A contrast/coherence error prints the failing pair
and `process.exit(1)` — a broken palette is never written to disk. If you add a palette
and it fails, fix the palette, not the linter.

## Output

```
index.html  404.html  site.json  validation.json  robots.txt  sitemap.xml  README.md
styles/tokens.css  styles/layout.css  scripts/main.js  assets/*.svg
```

`static` also writes `package.json` (serve script only) — no build step, testable offline.
`react` writes `src/App.jsx`, one component per section (`src/components/*.jsx`), and
`vite.config.js`; blocks are IR with `toHtml`/`toJsx`, so both stacks share the markup.

`site.json` is the machine spec (tokens, pages, section list, lint result) and
`validation.json` is a real check suite — the generated site is **not** trusted until:

```powershell
node "$F/serve.mjs" --root . --port 4173
node "$F/validate.mjs" --checks validation.json --out report --url http://localhost:4173
node "$F/budgets.mjs"  --url http://localhost:4173 --spec site.json --out budgets
node "$F/verify.mjs"   gate --dir . --require validate,budgets
```

Expected on a clean run: `validate` 38/38 at 390 + 1440, `budgets.ok: true`, no
`color-contrast` violations.

## Extending

- **New section** → add `BLOCKS.<name>()` returning the IR and list it in `sections`.
- **New language** → add a `COPY['xx']` deck; keep the same shape as `pt-BR`.
- **New tone** → add a `PALETTES` entry; the lint gate validates it for you.
- **Never** hand-edit a generated file: re-run `gen.mjs` (or fix the brief) so the
  token set stays consistent across pages.

## Limits

- Copy is a template deck: good for a real landing page, wrong for a brand voice. For a
  brand, write the copy in the brief and extend `COPY`.
- No remote images by design (`noExternal`): the site must render offline. For a brand
  font, self-host it with `assets.mjs fonts-local --spec site.json` (it reads
  `tokens.fonts`) and link `assets/fonts/fonts.css`.
- The generator is not a substitute for a reference. If the user named a site to copy,
  clone it (pipeline 1–9), do not approximate it with the generator.
