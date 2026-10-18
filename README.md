# fidelity

**Clone a design as a pixel-faithful build — and prove it with measurement, not vibes.**

A skill for coding agents (OpenCode, Claude Code, Codex, Cursor…) that turns a reference
page into a measured spec, a real build, and a mechanical gate. `spec.json` is the single
source of truth; every document, token file and acceptance check is generated from it.

![Generated site preview](docs/preview.png)

## Why

An agent can write a landing page in seconds. Matching an existing design is the hard
part: the eye sees a 3px baseline drift, a wrong font weight, a card that wraps one word
early. This skill replaces "looks close enough" with four things a machine can settle:

- **Measurement** — capture the reference at multiple widths, infer real breakpoints by
  bisection, and solve fluid values (`clamp()`) with the measurements as evidence.
- **A spec** — copy, boxes, colors, fonts, behavior and prohibitions in one file. Lint
  runs before generation and blocks broken design systems.
- **A build** — a static or React site from 9 composable blocks, or your own components,
  driven by the spec instead of hand-written CSS.
- **Proof** — DOM checks, pixel diff with cluster classification, a11y/contrast/weight
  budgets, and an independent visual judge. A green DOM check without a visual diff is
  explicitly treated as *unverified*.

The intended loop is three cycles max: diff → classify the cause → fix the spec, not the
symptom.

## Pipeline

| Stage | Tool | Output |
| --- | --- | --- |
| 0. Reference (optional) | `figma.mjs pull` | tokens, copy, blocks, draft spec |
| 1. Capture | `extract.mjs` | DOM inventory + screenshots at each width |
| 2. Understand | `digest.mjs`, `breaks.mjs` | compact outline, real breakpoints |
| 3. Contract | `spec.mjs init/check/build` | `spec.json` → `SPEC.md`, tokens, validation |
| 4. Build | `gen.mjs` or your code | static / React site |
| 5. Prove | `validate.mjs` | DOM/style/interaction checks |
| 6. Compare | `visual-diff.mjs`, `classify.mjs` | diff %, clusters, proposed cause/fix |
| 7. Second opinion | `judge.mjs` | schema-checked visual verdict |
| 8. Budgets | `budgets.mjs` | axe-core, contrast, page weight |
| 9. Gate | `verify.mjs gate` | one green/red verdict |

`gen.mjs` also initializes a git repo per project, and `project.mjs` gives you
`checkpoint` / `rollback` between fix cycles.

## Install

The repo is an agent skill: copy the folder where your agent looks for skills.

```bash
# OpenCode
git clone https://github.com/nasac0x/fidelity.git ~/.agents/skills/fidelity

# Claude Code
git clone https://github.com/nasac0x/fidelity.git ~/.claude/skills/fidelity
```

Windows: `%USERPROFILE%\.agents\skills\fidelity`. Then read `SKILL.md` — it is the router
the agent follows (stages, token budget, when to stop).

### Dependencies

Node 20+ and a Chromium for Playwright:

```bash
cd ~/.agents/skills/fidelity/scripts
npm install
npx playwright install chromium
```

Nothing else is required. The judge has a subagent fallback, so no API key is needed to
use the whole pipeline.

## Quickstart

```bash
cd ~/.agents/skills/fidelity/scripts

# 1. capture a reference at four widths
node extract.mjs --url http://localhost:3000 --out import --widths 390,768,1024,1440

# 2. inspect it without burning context
node digest.mjs --dir import --width 1440 --outline

# 3. infer real breakpoints
node breaks.mjs --url http://localhost:3000 --out import/breaks.json

# 4. spec -> generated documents
node spec.mjs init  --dir import --width 1440 --out spec/spec.json --name "Acme"
node spec.mjs check --spec spec/spec.json
node spec.mjs build --spec spec/spec.json --project .

# 5. build, then prove it
node serve.mjs --root . --port 4173
node validate.mjs  --checks validation.json --out report --url http://localhost:4173
node visual-diff.mjs --pairs pairs.json --out visual-report
node budgets.mjs   --url http://localhost:4173 --spec spec/spec.json --out budgets
node verify.mjs    gate --dir . --require validate,visual,budgets
```

No reference? Generate a complete site from a brief:

```bash
node gen.mjs --name "Northwind" --niche saas --locale pt-BR --out ../northwind
```

It writes tokens, 9 blocks, a validation suite that already passes, and a git repo.
See `references/generator.md`.

## Fonts and credentials

Never hotlink. `assets.mjs fonts-local --spec spec/spec.json` downloads the woff2 subsets,
verifies the `wOF2` magic, and writes `assets/fonts/fonts.css` + a sha256 manifest. Link
that CSS and drop the Google `<link>`.

Optional keys live in `~/.fidelity.json` (outside the repo), overridable by environment:

```json
{ "figma": { "token": "figd_…" },
  "googleFonts": { "key": "AIza…" },
  "judge": { "url": "https://generativelanguage.googleapis.com/v1beta/openai",
             "key": "…", "model": "gemini-3.8-flash" } }
```

`FIGMA_TOKEN`, `GOOGLE_FONTS_API_KEY`, `FIDELITY_JUDGE_URL/KEY/MODEL` win over the file.
Tokens are read, never printed. The judge speaks the OpenAI-compatible shape, so any
multimodal endpoint works.

## Honest limits

- The last end-to-end run was against **locally generated** sites. Production hardening
  (CDNs, remote webfonts, cross-origin CSS, lazy-load) is the next milestone — treat
  public-site clones as beta.
- The Figma pull (tokens, copy, blocks, draft spec) is tested against a saved fixture.
  Image export needs a real file URL; a `/files/` dashboard URL has no key.
- The API judge path is tested with Gemini. Without a key, the bundle doubles as the
  subagent prompt and the verdict is verified by schema, not trusted blindly.
- The React stack is a template, not a framework integration: no Next.js/Remix, no
  component library presets yet.

## Layout

```
SKILL.md                 router: rules, pipeline, token budget
ROADMAP.md               what is done / what is next
rules/pitfalls.jsonl     failures as data; rules/pitfalls.md is generated
references/              spec template, generator, Figma
scripts/                 the pipeline; node scripts/syntax.mjs checks all of it
docs/                    preview images
```

## Conventions

- One JSON summary line per run; failures print with the measured value.
- Every value in generated CSS carries the measurements it came from.
- Lint errors block generation (`exit 1`); warnings do not.
- A green DOM validation without a visual diff is **unverified**.

## License

MIT — see [LICENSE](LICENSE).
