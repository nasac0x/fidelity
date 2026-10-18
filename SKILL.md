---
name: fidelity
description: Rebuild a design (page, section, component) as an exact pixel-fidelity clone from a reference (URL, screenshot, or existing code). Generates a deterministic SPEC with exact copy, typography, colors, layout math, assets, and behavior, then executes it and auto-validates with Playwright (screenshots, computed styles, DOM checks) until it passes. Use when the user asks to clone, recreate, or replicate a design pixel-perfect, or to turn a reference implementation into a rebuildable spec. Not for free-form design work (use impeccable) or throwaway prototypes.
---

# Fidelity

Rebuild a design as a pixel clone, verified by **measurement, not taste**.
`spec.json` is the single source of truth; `SPEC.md`, `validation.json`, `tokens.css`,
`layout.css` and the tailwind config are **generated** from it — never hand-edited.

A build that passes DOM checks without an element-level image comparison is
**unverified, not done**.

## Non-negotiable rules

1. **The reference wins.** If it is measurable, measure it; never "improve" it.
2. **Never read raw artifacts.** `inventory*.ndjson`, `report.json`, `validation.json`
   are machine files. Read them through `digest.mjs` (a few hundred tokens, not 350k).
3. **One image per cycle:** `contact-sheet.png`. Open a single `*.diff.png` only to zoom.
4. **Max 3 fix → re-validate cycles.** Then stop and report exactly what still differs.
5. **Every failure gets a rule.** After a fix: `pitfalls.mjs add` (one line, with tags).
6. Keep the build local. Never publish or deploy it.

## Setup (once)

```powershell
$F = "$HOME/.agents/skills/fidelity/scripts"
if (-not (Test-Path "$F/node_modules")) { npm --prefix $F install }
node "$F/serve.mjs" --root . --port 4173        # zero-dep static server, keep running
```

Windows: never pass bracketed JS through `node -e` (PowerShell mangles it) — write a
temp `.mjs`, `node --check` it, run it. Node scripts must be run **from `scripts/`**
(ESM resolves packages from the script path, not the cwd).

Builds live in `C:\Users\victo\Desktop\PROJETOS\<project-name>\`.

## Pick a mode

| Mode | When | Enter at |
| --- | --- | --- |
| **Clone page** | URL or full-page screenshot | 1 |
| **Clone component** | one section/feature | 1, with `--focus "sel"` |
| **Figma file** | a Figma URL (token in `~/.fidelity.json`) | `figma.mjs pull` (see `references/figma.md`) |
| **Generate** | no reference, a brief/niche | `gen.mjs` (see `references/generator.md`) |
| **Fix a build** | a build exists and diff fails | 4 |

## Pipeline

Every stage writes an artifact. Each stage names the one thing you are allowed to read.

### 0 — Figma as the reference (optional)

```powershell
node "$F/figma.mjs" pull --file "<figma url>" --out spec/figma `
  --images --spec-out spec/figma/spec.json
```

Writes `tree.json`, `tokens.json`, `copy.json`, `blocks.json`, `images/` and a draft
spec. It is a starting point: Figma has no DOM, so breakpoints and layout math still
come from `extract`/`spec.mjs`. See `references/figma.md`.

### 1 — Extract

```powershell
node "$F/extract.mjs" --url http://localhost:3000 --out import `
  --widths 390,1440 --shots "hero:section.hero;;nav:.site-nav"
```

Writes `inventory-<w>.ndjson`, `page-<w>.html`, `reference-<w>.png`,
`element-<w>-<key>.png`, `assets.json`, `run.json`.
Read: `node "$F/digest.mjs" --dir import --width 1440 --outline` (add `--copy`,
`--styles`, `--vs 390`, `--region y0-y1`).

### 2 — Real breakpoints (not guesses)

```powershell
node "$F/breaks.mjs" --url http://localhost:3000 --out import/breaks.json
```

Emits `regimeBoundaries` (layout/typography decisions), `reflowPoints` (text wrapping,
reported only) and a lean `ladder` of widths. Use `--widths-file import/breaks.json`
on the next `extract`/`validate` so you capture only the widths that matter.

### 3 — Spec (machine → documents)

```powershell
node "$F/spec.mjs" init  --dir import --width 1440 --out spec/spec.json --name "Acme"
# fill name/scope/behavior/copy overrides in spec.json (small JSON, not prose)
node "$F/spec.mjs" check --spec spec/spec.json      # errors block, warnings do not
node "$F/spec.mjs" build --spec spec/spec.json --project .
```

`build` writes `SPEC.md` (the contract), `validation.json` (the test suite),
`tokens.css`, `layout.css` (each value cites the measurements it came from) and
`tailwind.config.cjs`. Fluid values become `clamp()`, stepped ones become media queries.
`spec.mjs css --emit css|tailwind|scss` re-emits tokens only. `spec.mjs drift --dir import`
detects a reference that changed under you.

**Fonts: never hotlink.** Self-host the woff2 and keep the licence:

```powershell
node "$F/assets.mjs" fonts-local --spec spec/spec.json   # -> assets/fonts/{fonts.css,*.woff2}
node "$F/assets.mjs" search --query "manrope"            # names/weights (needs GOOGLE_FONTS_API_KEY)
```

`fonts-local` fetches CSS2 with a Chrome UA, downloads only `latin,latin-ext` by default
(`--subsets all` to keep every subset), verifies the `wOF2` magic, and writes
`fonts.css` + `fonts.json` (sha256, source, licence note). Link that CSS and delete the
Google `<link>`. `assets.mjs fonts --write` then measures a metric-compatible fallback
(`size-adjust`/`ascent-override`) so the first paint does not reflow.

### 4 — Build

Implement `SPEC.md` literally: same selectors, same copy (character counts were
measured), same layout math. Do not add or remove sections.

### 5 — Validate (DOM + computed styles + a11y)

```powershell
node "$F/validate.mjs" --checks validation.json --out report --url http://localhost:4173
```

Read the summary line only (`38/38 passed, 0 failed`). `--all` prints every check.
Failing checks print with the measured vs expected value.

### 6 — Visual diff (mandatory)

```powershell
# pairs.json: { "pairs": [{ "name":"hero","width":1440,"ref":"import/element-1440-hero.png",
#                           "build":"report/element-1440-hero.png" }], "masks": {...} }
node "$F/visual-diff.mjs" --pairs pairs.json --out visual-report
```

Read `visual-report/contact-sheet.png` **once**. Deterministic grid+cluster scoring,
odiff/pixelmatch cross-check, masks for substituted brand art.
Then classify what failed:

```powershell
node "$F/classify.mjs" --visual visual-report/report.json --out visual-report/fixplan.json
```

### 7 — Independent judge (second opinion)

```powershell
node "$F/judge.mjs" bundle --visual visual-report/report.json --spec spec/spec.json --out judge
node "$F/judge.mjs" call   --bundle judge/bundle.json --out judge   # needs FIDELITY_JUDGE_URL/KEY/MODEL
node "$F/judge.mjs" verify --file judge/verdict.json --bundle judge/bundle.json
```

`call` speaks the OpenAI-compatible shape, so Gemini works with
`url=https://generativelanguage.googleapis.com/v1beta/openai` and a current model
(e.g. `gemini-3.8-flash`). A 404 naming a retired model is a model problem, not a key
problem — update `judge.model` in `~/.fidelity.json`.

No endpoint? The bundle **is** the subagent input: hand `judge/prompt.md` +
`judge/sheet.png` to a subagent and save its JSON as `judge/verdict.json`.
`verify` rejects a verdict that skips a region or looks at nothing.

### 8 — Budgets (a11y, contrast, weight)

```powershell
node "$F/budgets.mjs" --url http://localhost:4173 --spec spec/spec.json --out budgets --widths 1440
```

Real axe-core run + contrast of every token pair on every surface + page weight.

### 9 — Done means the gate is green

```powershell
node "$F/verify.mjs" gate --dir . --require validate,visual,budgets,judge
```

`gate` merges every `gate.json` into one verdict. Only then report success — and say
what you verified and what you masked.

`gen.mjs` also `git init`s the project (skip with `--no-git`). Before a risky fix cycle:

```powershell
node "$F/project.mjs" checkpoint --dir . --name cycle-2     # commit + tag fidelity/cycle-2
node "$F/project.mjs" rollback   --dir . --to fidelity/cycle-2 --yes
node "$F/project.mjs" status     --dir .
```

## Token budget

| Do | Don't |
| --- | --- |
| `digest.mjs --outline` (≤80 lines) | `cat inventory-1440.ndjson` |
| `contact-sheet.png` once | open 6 diff PNGs one by one |
| one line per failure + the fix | re-narrate the pipeline |
| `--max 20`, `--region`, `--selector` | dump a full 40k-node page |

## Tools

`extract` · `digest` · `breaks` · `spec` · `figma` (me/pull) · `gen` · `serve` · `validate` ·
`visual-diff` · `classify` · `judge` · `budgets` · `assets` (fetch / fonts / fonts-local /
search / placeholder / inventory) · `project` (git: init/checkpoint/rollback/status) ·
`verify` (gate/sources) · `pitfalls` · `probe` (ad-hoc, bounded) · `ocr` (text baked in
images) · `scan` / `sample` (inspect PNG pixels).

Every tool prints one JSON summary line; failures print `✗` with the measured value.

## When something fails

```powershell
node "$F/pitfalls.mjs" list --tag visual     # rules that matched previous failures
node "$F/pitfalls.mjs" add --rule "do not ..." --trigger "what broke" --tags visual,css
node "$F/pitfalls.mjs" sync                 # regenerate rules/pitfalls.md
```

`spec.mjs build` injects only the rules whose tags match the spec's tags, by id.
The failure is the input; the rule is the output.

## Files

- `scripts/` — the pipeline (each file starts with a usage comment).
- `references/spec-template.md` — how to fill `spec.json` and what `build` generates.
- `references/generator.md` — generator mode: brief → design system → site.
- `references/figma.md` — Figma as the reference: tokens, copy, exports, limits.
- `rules/pitfalls.jsonl` — failures as data (`rules/pitfalls.md` is the generated view).
- `ROADMAP.md` — what is done, what is next.
