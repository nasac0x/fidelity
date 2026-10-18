# ROADMAP — `fidelity` v3

v2 era uma skill semi-manual: uma seção por run, CSS escrito à mão, eu abrindo cada
`diff.png`. v3 é um **pipeline executável**: `spec.json` é a fonte única, os documentos
são gerados, e o "pronto" é um gate mecânico.

## Entregue em v3

| Capacidade | Onde | Como sei que funciona |
| --- | --- | --- |
| Codegen de layout a partir de medidas | `spec.mjs build` + `lib/scale.mjs` | `SPEC.md`, `layout.css` e `tokens.css` gerados; 14 valores fluidos, 0 erros de lint |
| Breakpoints inferidos (não adivinhados) | `breaks.mjs` | detecta `@media (min-width:760px)`; ladder de 26 larguras em vez de 86 |
| Capturas paralelas | `extract.mjs --workers` | N páginas Playwright simultâneas |
| Classificador de diff | `classify.mjs` | agrupa falhas em clusters com causa provável |
| Diff determinístico + cross-check | `visual-diff.mjs` + `lib/img.mjs` | grid/clusters, máscaras, odiff/pixelmatch, contact sheet |
| Interações medidas | `probe.mjs` (amostragem limitada) + check `probe` | ciclo de 5,65 s medido sem travar o shell |
| Design system + linter duro | `gen.mjs` + `lib/scale.mjs` | `muted` 5,18:1 / 4,53:1 nas duas superfícies; lint error ⇒ `exit 1` |
| Biblioteca de blocos (IR → HTML/JSX) | `gen.mjs` | 9 seções, `static` e `react` a partir do mesmo IR |
| Copy PT-BR/EN + assets SVG | `gen.mjs` | zero requisição externa |
| Multipágina, 404, formulário validado, SEO | `gen.mjs` | `pages[]`, `404.html`, `aria-invalid`, `sitemap.xml` |
| Judge visual plugável | `judge.mjs` bundle/call/verify | `verify` rejeita veredito que pula região; funciona por subagente |
| Budgets reais | `budgets.mjs` | axe-core + contraste token×superfície + peso; `ok:true` |
| Gate mecânico final | `verify.mjs gate` | `ok:true` com validate+visual+budgets+judge+spec |
| Pitfalls como dados | `rules/pitfalls.jsonl` + `pitfalls.mjs` | 31 regras; `spec.mjs build` injeta só as que casam por tag |
| Fontes self-hosted | `assets.mjs fonts-local` | baixa woff2 (latin/latin-ext), valida `wOF2`, escreve `fonts.css` + sha256, zero hotlink |
| Figma como fonte | `figma.mjs pull` | tree/tokens/copy/blocks + PNG/SVG, draft de spec; auth validada (`/v1/me`) |
| Syntax gate | `syntax.mjs` | 24 arquivos, `ok:true` |

Prova ponta a ponta (offline, site gerado): `gen → serve → validate 38/38 → budgets ok →
extract → digest → breaks → visual-diff 6/6 → classify → judge bundle/verify 2/2 →
verify gate ok`.

## Tier 1 — clone full-page

| # | Item | Status |
| --- | --- | --- |
| 1 | Codegen de layout em vez de CSS manual | ✅ solver com `clamp()`/steps e evidência por valor |
| 2 | Matriz de breakpoints inferida | ✅ outlier local por feature + bisseção; reflow separado do regime |
| 3 | Paralelização de capturas | ✅ `--workers` em `extract.mjs` |
| 4 | Classificador automático de diffs | ✅ `classify.mjs` (clusters + causa + fix proposto) |
| 5 | Interações/hover como spec executável | ✅ `hover`/`focus`/`scroll` como checks de primeira classe; `behavior[].check` vira check |

## Tier 2 — gerador

| # | Item | Status |
| --- | --- | --- |
| 6 | Design system interno coerente | ✅ tokens + `lintTokens` como gate duro |
| 7 | Biblioteca de composição | ✅ 9 blocos com variantes por tom de paleta; ⚠️ sem variantes shadcn/Radix (CSS próprio) |
| 8 | Copy + assets internos | ✅ decks PT-BR/EN, SVG gerados, sem rede |
| 9 | Multipágina e estados | ✅ páginas, 404, form validado, sitemap/robots; ⚠️ sem estado "vazio" por página |
| 10 | Brief → repo sem passos manuais | ✅ `gen.mjs` escreve `validation.json` e o site já passa nos gates |

## Tier 3 — qualidade e operação

| # | Item | Status |
| --- | --- | --- |
| 11 | Visual judge independente | ✅ testado de ponta a ponta com Gemini 3.8 Flash (endpoint OpenAI-compatible); veredito 2/2 regiões |
| 12 | Budgets (a11y/perf/contraste) | ✅ axe + contraste + peso; Lighthouse descartado de propósito (budget local) |
| 13 | git por projeto | ✅ `gen.mjs` inicializa o repo; `project.mjs` checkpoint/rollback/status |
| 14 | Cache/licenciamento de fontes | ✅ `fonts-local` baixa woff2 por subset + `fonts --write` gera fallback com `size-adjust`; ⚠️ manter o arquivo de licença junto |

## Pendente, em ordem

1. **Hardening em site real**: CDN, webfonts remotas, CSS cross-origin, lazy-load.
   Todo o e2e rodou contra um site local gerado — é o maior risco aberto.
2. **Figma com arquivo real**: o pull (tokens/copy/blocks/draft spec) está testado com
   fixture; falta exercitar o export de imagens (`/v1/images/:key`) com uma URL de arquivo.
3. **Figma além do pull**: variáveis (Enterprise), componentes → componentes de código,
   auto-layout → grid/flex.
4. **Estado vazio por página** no gerador.
5. **Variantes shadcn/Radix**: o design system é CSS próprio; falta um preset de componentes.

## Ferramentas e acessos

| Necessidade | Ferramenta | Status |
| --- | --- | --- |
| Browser multi-width | Playwright | ✅ |
| Diff visual | odiff-bin + pixelmatch + jimp | ✅ |
| OCR | tesseract (por/eng) | ✅ |
| Vídeo/áudio | ffmpeg | ✅ |
| Juiz visual | endpoint OpenAI-compatível **ou** subagente | ⚠️ falta endpoint |
| Figma | personal access token em `~/.fidelity.json` | ✅ token validado (`/v1/me`) |
| Fontes | Google Fonts self-hosted (`assets.mjs fonts-local`) + fallback com `size-adjust` | ✅ |
| Metadados de fontes | Webfonts API (`googleFonts.key`) | ✅ |
| CI | gate local (`verify.mjs gate`) | ✅ |

## Definition of done

```powershell
$F = "$HOME/.agents/skills/fidelity/scripts"
node "$F/verify.mjs" gate --dir . --require validate,visual,budgets,judge
```

`ok:true` ⇒ pode reportar sucesso. `ok:false` ⇒ reportar exatamente o que falta, sem
"quase pronto".
