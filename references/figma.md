# Figma as the reference

Figma is the only source that hands you tokens, copy and geometry **before** a page
exists. `figma.mjs` reads the file through the REST API and writes data the rest of the
pipeline already understands.

```powershell
$F = "$HOME/.agents/skills/fidelity/scripts"
node "$F/figma.mjs" me                                   # is the token alive?
node "$F/figma.mjs" pull --file "<figma url>" --out spec/figma `
  --images --spec-out spec/figma/spec.json
```

`--file` accepts a `figma.com/design|file/<key>/...?node-id=1-2` URL, a bare file key, or
a saved API response (`--fixture saved.json`, fully offline).

## Auth (once)

`~/.fidelity.json` (user-level, never in the repo):

```json
{ "figma": { "token": "figd_...", "file": "" },
  "googleFonts": { "key": "AIza..." },
  "judge": { "url": "", "key": "", "model": "" } }
```

Environment overrides it: `FIGMA_TOKEN`, `GOOGLE_FONTS_API_KEY`, `FIDELITY_JUDGE_*`.
Never pass a token on the command line (shell history) and never print it — `figma.mjs`
only logs `ok`/status codes.

## What `pull` writes

| File | Contents | Use |
| --- | --- | --- |
| `tree.json` | frame tree: id, name, type, absolute box, text | orientation without screenshots |
| `tokens.json` | colors (hex + usage + style name), fonts (body/heading/display), radius, shadows | `spec.tokens` |
| `copy.json` | every TEXT node: `characters`, style, box, char count | `spec.copy` (exact strings) |
| `blocks.json` | top-level sections: name, `role`, box at the frame width | `spec.blocks` |
| `images.json` + `images/` | PNG exports at `--scale 2` (raster fills) and SVG for vectors | `spec.assets` |
| `spec.json` (`--spec-out`) | draft spec: the five above + `acceptance: [a11y]` | starting point, **not** a finished spec |

The draft is deliberately thin: Figma gives design pixels, not a DOM. `spec.mjs check`
will warn about the missing `source.url` and `behavior`; that is correct until the page
is built and extracted.

## Workflow

1. `figma.mjs pull` → `spec/figma/spec.json` (**its own directory**: `spec.mjs build`
   writes `SPEC.md` next to the spec it is given).
2. `spec.mjs check --spec spec/figma/spec.json` → fix `name`, `scope`, `stack`.
3. Fill `behavior` from the prototype (hover/scroll/autoplay) — Figma does not encode it.
4. `spec.mjs build --spec spec/figma/spec.json --project build/figma` → `SPEC.md`,
   `tokens.css`, `layout.css`, `validation.json`.
5. Build from `SPEC.md`. Then run the normal pipeline (`extract` on the *build*,
   `validate`, `visual-diff` against the Figma frame export) and **merge the measured
   values back** into the real `spec/spec.json`.

Figma and the browser disagree on purpose: frames are fixed-width, the web is fluid.
Treat Figma as the truth for copy, tokens and composition; treat the extracted DOM as
the truth for breakpoints and layout math.

## Limits

- **Variables API** (`/v1/files/:key/variables/local`) is Enterprise-only; this tool
  reads node properties, which work on every plan.
- **Components → code** is not automatic: `figma.mjs` gives you structure, not React.
  The generator (`gen.mjs`) is for sites without a reference.
- **Text** comes back with `lineHeightPx` and `letterSpacing`, which map to CSS; OpenType
  features and variable-font axes do not survive the API.
- **Images** are raster exports (2×); a vector logo exported as PNG will not scale.
  Export vectors as SVG when the node is a `VECTOR` (handled automatically).
- **Auto-layout** constraints are not converted into CSS `flex`/`grid` rules. Read
  `tree.json` and write the layout in `SPEC.md`; the measurements still come from
  `spec.mjs`.
