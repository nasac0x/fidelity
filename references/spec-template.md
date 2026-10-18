# `spec.json` — the only file you author

`spec.mjs init` writes it from a *measured* inventory (4 widths). Almost everything in
it is measurement: leave it alone. You edit four things, and only these:

| Field | What to put | Why it is yours |
| --- | --- | --- |
| `name`, `scope`, `identity`, `stack` | project name, what is in scope, `de-branded` or `with-brand`, target stack | not measurable |
| `behavior[]` | interactions/animations the reference has (`what`, `selector`, `notes`, `check`) | measurements prove layout, not intent |
| `copy[]` | corrections **only** when the DOM text is provably wrong (text baked into an image → `ocr.mjs`) | otherwise the measured string wins |
| `acceptance[]` | extra checks you want enforced (rare) | project-specific |

Everything else — `tokens`, `blocks`, `assets`, `responsive`, `semantics`,
`breakpoints`, `provenance` — is evidence. Editing it by hand makes the build match
your taste instead of the reference.

## Shape

```jsonc
{
  "name": "Acme",
  "scope": "landing page, hero → footer",
  "identity": "de-branded",
  "stack": "React + TS + plain CSS (no animation/UI/canvas libraries)",
  "source": { "url": "http://localhost:3000", "capturedAt": "..." },
  "designWidth": 1440,
  "widths": [390, 768, 1024, 1440],
  "breakpoints": [{ "px": 760, "kind": "max" }],
  "tags": ["de-branded", "clone", "visual"],       // drives which pitfalls get injected
  "tokens": {
    "colors": [{ "name": "ink", "hex": "#0d1117", "role": "text", "usage": 44 }],
    "fonts": [{ "role": "body", "family": "Manrope", "weight": 400, "size": "16px",
                "lineHeight": "25.6px", "fallback": { "family": "Arial", "sizeAdjust": "105.2%" } }],
    "space": { "unit": 4, "steps": [8, 12, 16, 24, 32, 48] },
    "radius": [{ "name": "sm", "value": "8px" }],
    "screens": [{ "name": "md", "min": "760px" }]
  },
  "copy": [{ "id": "c01", "selector": "a.btn.btn-primary", "block": "btn",
             "text": "Começar agora", "chars": 13, "font": "Manrope 600 16px" }],
  "blocks": [{ "name": "hero", "selector": "section.hero", "role": "region",
               "measure": { "1440": { "box": [0, 69, 1440, 803], "props": { "paddingTop": "140px" } } },
               "children": [] }],
  "behavior": [{ "what": "carousel autoplay", "selector": ".slides", "notes": "5.65s cycle, wrap at 28s" }],
  "prohibitions": [],          // generated: rule ids injected by tag
  "noExternal": true,          // build must not make third-party requests
  "provenance": { "generator": "spec.mjs init", "inventory": "import", "widths": [390, 768, 1024, 1440] }
}
```

## Generated (never hand-edit)

| File | Contents | Read it? |
| --- | --- | --- |
| `SPEC.md` | the contract: copy, tokens, layout math, assets, behavior, failure modes | **yes** — it is the build brief |
| `validation.json` | every check, machine-readable | no — `validate.mjs` reads it |
| `tokens.css` | colors, fonts (+ metric-compatible `@font-face`), space, radius, `--font-fallback` | paste into the build |
| `layout.css` | per-block variables, one comment per value citing its measurements | paste into the build |
| `tailwind.config.cjs` | the same tokens as a Tailwind theme | optional |

## What the scale solver does

Each value is solved from its samples (one per captured width):

1. **1 sample** → constant.
2. **Interior points on a line, extremes flat** → `clamp(min, A + Bvw, max)`, using the
   *measured* min/max. This recovers what a human wrote: `clamp(48px, 10vw, 140px)`.
3. **Otherwise** → steps, emitted as `@media (min-width: …)` overrides (never nested in `:root`).
4. Every value keeps its evidence: `/* fluid ±1px · 390:48px 768:76.8px 1024:102.4px 1440:140px */`.

`lintTokens` runs before anything is written and **errors block the build**:
4px grid (warn), type-scale jumps (warn), and contrast of every foreground
(`ink`, `muted`, `accent`) on **every** surface (`surface`, `surface-alt`) — plus
`inverse`/`accentInk` on `accent`.

## Check types (`validation.json`)

`exists` · `noExists` · `count` · `visible` · `text` · `textContains` · `textMatches` ·
`style` · `boundingBox` (accepts `x`/`left`, `y`/`top`) · `attr` · `value` · `font` ·
`contrast` · `a11y` · `scrollHeight` · `noRequest` · `requestBudget` · `probe` ·
`hover` · `focus` · `scroll`.

The last three test **states**, not just the resting DOM:

```json
{ "type": "hover",  "selector": ".btn-primary", "prop": "transform", "requireChange": true }
{ "type": "focus",  "selector": ".nav-links a", "prop": "outlineStyle", "equals": "solid", "via": "tab" }
{ "type": "scroll", "selector": "header", "scrollTo": 800, "position": "sticky", "viewportTop": 0 }
```

`hover` reads the property before, during and after the pointer leaves, so a broken
transition or a stuck `:hover` fails. `focus` can reach the element with real `Tab`
presses (`via: "tab"`) to exercise `:focus-visible`, not just `.focus()`. `scroll`
reports viewport coordinates — that is where `position: sticky` actually lives.

Any `behavior[]` entry can carry `check` (or `checks`); `spec.mjs build` copies it into
`validation.json` with `from: behavior:<what>`. A behavior without `check` stays prose.

Each check carries `from` (the copy id / block that produced it), so a failure points
back at the measurement, not at a number you have to hunt.

## Commands

```powershell
node spec.mjs init  --dir import --width 1440 --out spec/spec.json --name "Acme"
node spec.mjs check --spec spec/spec.json        # errors=exit 1, warnings=exit 0
node spec.mjs build --spec spec/spec.json --project .   # writes the 5 generated files
node spec.mjs css   --spec spec/spec.json --emit css|tailwind|scss
node spec.mjs drift --spec spec/spec.json --dir import   # did the reference change?
```

`check` proves the spec is *internally* consistent (selectors exist, copy matches, tokens
pass contrast). `drift` proves it still matches the reference you captured.
