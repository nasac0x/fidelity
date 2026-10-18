# Pitfalls (generated from rules/pitfalls.jsonl — edit the JSONL, not this file)

36 rules. `hits` counts how many runs actually tripped the rule.

## a11y

- **P-027** emit a colour pair without checking contrast on every surface it can sit on — _muted text passed on surface and failed 4.4:1 on surface-alt (axe caught 6 nodes)_ · hits=1 · 2026-10-18

## always

- **P-001** rewrite, paraphrase or "fix" pinned strings — preserve spelling, capitalisation and punctuation exactly — _copy was "improved" or typo-fixed in a fidelity clone_ · 2026-10-18
- **P-009** show the confirmed brand name, logo or domain when the brief is de-branded — _brand recovered from metadata was printed on the page_
- **P-010** publish or deploy a build that was asked to stay local — _a keep-it-local build was pushed to a public URL_
- **P-019** report success after DOM checks with no visual comparison — _a green DOM run shipped a grey-gradient placeholder hero_ · hits=1 · 2026-10-18

## assets

- **P-002** trace, regenerate, typeset or approximate a supplied logo — use its exact path data — _logo redrawn from a screenshot instead of the supplied SVG_
- **P-003** substitute a specified font family for a look-alike — _font swapped for a more common family and the metrics drifted_
- **P-005** alter escaping, underscores or path segments of a pinned asset URL — _a rewritten URL 404'd and the image silently disappeared_
- **P-006** substitute a "similar" video or image for the pinned source — _a stock clip replaced the specified one_
- **P-020** replace brand art with a flat rectangle — rebuild the block as DOM with the same composition and mask what remains — _a flat placeholder lost the whole hero composition_ · hits=1 · 2026-10-18
- **P-032** hotlink Google Fonts or a CDN in a build that must stay local — download the woff2 with assets.mjs fonts-local and ship the licence — _a keep-it-local build still made third-party font requests; noRequest/budgets caught it_ · 2026-10-18

## brand

- **P-009** show the confirmed brand name, logo or domain when the brief is de-branded — _brand recovered from metadata was printed on the page_

## cli

- **P-013** pass bracketed JS through node -e in PowerShell — write a temp .mjs and node --check it — _PowerShell ate the regex/brackets and the probe ran on a mangled string_ · hits=1 · 2026-10-18
- **P-026** put commas inside comma-separated CLI sub-values — use ;; between entries or a JSON file — _selector lists split at the wrong comma_ · hits=1 · 2026-10-18
- **P-031** pipe a long-running node process into Select-Object -First N in PowerShell — it stops the pipeline and kills the process mid-run — _extract.mjs died after writing inventory ndjson and never wrote inventory.json, because the command ended in | Select-Object -First 3_ · 2026-10-18
- **P-033** print, commit or pass an API token on the command line — read it from ~/.fidelity.json / env and log only ok|status — _a Figma and a Google Fonts key were pasted into chat and had to be treated as exposed_ · 2026-10-18
- **P-034** treat --out as a directory when it is one — appending the filename only when the argument is not an existing dir — _judge.mjs call --out judge threw EISDIR because it opened the directory as the verdict file_ · 2026-10-18
- **P-036** figma.com/files is the dashboard and carries no file key — a pull needs figma.com/design/<key>/... — _a dashboard URL was passed to figma.mjs pull and produced a confusing API 404_ · 2026-10-18

## clone

- **P-001** rewrite, paraphrase or "fix" pinned strings — preserve spelling, capitalisation and punctuation exactly — _copy was "improved" or typo-fixed in a fidelity clone_ · 2026-10-18
- **P-002** trace, regenerate, typeset or approximate a supplied logo — use its exact path data — _logo redrawn from a screenshot instead of the supplied SVG_
- **P-003** substitute a specified font family for a look-alike — _font swapped for a more common family and the metrics drifted_

## copy

- **P-001** rewrite, paraphrase or "fix" pinned strings — preserve spelling, capitalisation and punctuation exactly — _copy was "improved" or typo-fixed in a fidelity clone_ · 2026-10-18

## css

- **P-028** emit var(--x) without defining --x — a missing custom property kills the whole declaration — _--font-fallback was referenced by every font stack and never declared_ · hits=1 · 2026-10-18

## deploy

- **P-010** publish or deploy a build that was asked to stay local — _a keep-it-local build was pushed to a public URL_

## diff

- **P-019** report success after DOM checks with no visual comparison — _a green DOM run shipped a grey-gradient placeholder hero_ · hits=1 · 2026-10-18
- **P-021** diff whole pages — capture the same selector on both sides at the same viewport widths — _full-page screenshots can never align (different page furniture)_ · hits=1 · 2026-10-18
- **P-023** trust a single diff scorer — fall back to pixelmatch and still emit diff% plus a bbox — _odiff's server intermittently threw reading 'map' on successive comparisons_ · hits=1 · 2026-10-18
- **P-025** keep a diff pair whose selector has no stable non-zero box — drop it and mask the region — _a 0-width wrapper kept failing while its children painted full width_ · hits=1 · 2026-10-18

## extraction

- **P-011** rely on the capped whole-page inventory to prove text does or does not exist — do a dedicated subtree extraction — _the 400-element cap missed the hero DOM because its text was baked into banner images with load-bearing alt_ · hits=1 · 2026-10-18

## figma

- **P-036** figma.com/files is the dashboard and carries no file key — a pull needs figma.com/design/<key>/... — _a dashboard URL was passed to figma.mjs pull and produced a confusing API 404_ · 2026-10-18

## fonts

- **P-003** substitute a specified font family for a look-alike — _font swapped for a more common family and the metrics drifted_
- **P-004** let the browser synthesise bold or italic — ship real files and set font-synthesis: none — _synthetic bold widened the headline and broke line breaks_
- **P-032** hotlink Google Fonts or a CDN in a build that must stay local — download the woff2 with assets.mjs fonts-local and ship the licence — _a keep-it-local build still made third-party font requests; noRequest/budgets caught it_ · 2026-10-18

## interaction

- **P-007** add an overlay or scratch canvas instead of implementing the specified scrub — _a recorded effect was faked with an overlay_

## judge

- **P-034** treat --out as a directory when it is one — appending the filename only when the argument is not an existing dir — _judge.mjs call --out judge threw EISDIR because it opened the directory as the verdict file_ · 2026-10-18
- **P-035** normalize names coming from an external judge before matching (strip a trailing @width) — _the model answered hero@390 as both name and width and verify rejected a correct verdict as an invented region_ · 2026-10-18

## layout

- **P-017** let a pagination row stretch — it is width:fit-content with margin-inline:auto — _measured content boxes of 88/104/136px, never full width_ · hits=1 · 2026-10-18

## logo

- **P-002** trace, regenerate, typeset or approximate a supplied logo — use its exact path data — _logo redrawn from a screenshot instead of the supplied SVG_

## motion

- **P-007** add an overlay or scratch canvas instead of implementing the specified scrub — _a recorded effect was faked with an overlay_
- **P-018** infer temporal behaviour from structure checks — use the autoplay probe and budget ~30s of sampling — _auto cycle measured 5.65s hold-5.0s + 0.6s transition, seamless wrap at ~28s_ · hits=1 · 2026-10-18

## noExternal

- **P-032** hotlink Google Fonts or a CDN in a build that must stay local — download the woff2 with assets.mjs fonts-local and ship the licence — _a keep-it-local build still made third-party font requests; noRequest/budgets caught it_ · 2026-10-18

## ocr

- **P-011** rely on the capped whole-page inventory to prove text does or does not exist — do a dedicated subtree extraction — _the 400-element cap missed the hero DOM because its text was baked into banner images with load-bearing alt_ · hits=1 · 2026-10-18
- **P-020** replace brand art with a flat rectangle — rebuild the block as DOM with the same composition and mask what remains — _a flat placeholder lost the whole hero composition_ · hits=1 · 2026-10-18

## playwright

- **P-012** run ad-hoc Playwright scripts from outside scripts/ — ESM resolves packages from the script path, not cwd — _ERR_MODULE_NOT_FOUND: cannot find package playwright from a TEMP script_ · hits=1 · 2026-10-18
- **P-014** park a forever-promise inside page.evaluate — sample the DOM from Node in a bounded loop — _an autoplay probe hung the shell twice until timeout_ · hits=1 · 2026-10-18

## png

- **P-022** parse PNGs with pngjs — use jimp; odiff's decoder reads files pngjs rejects — _"unrecognised content at end of stream" on Playwright element screenshots_ · hits=1 · 2026-10-18

## ports

- **P-016** start the dev server without preflighting a free port — _port 3000 was already taken by an unrelated process_ · hits=1 · 2026-10-18

## powershell

- **P-013** pass bracketed JS through node -e in PowerShell — write a temp .mjs and node --check it — _PowerShell ate the regex/brackets and the probe ran on a mangled string_ · hits=1 · 2026-10-18
- **P-031** pipe a long-running node process into Select-Object -First N in PowerShell — it stops the pipeline and kills the process mid-run — _extract.mjs died after writing inventory ndjson and never wrote inventory.json, because the command ended in | Select-Object -First 3_ · 2026-10-18

## probes

- **P-014** park a forever-promise inside page.evaluate — sample the DOM from Node in a bounded loop — _an autoplay probe hung the shell twice until timeout_ · hits=1 · 2026-10-18
- **P-018** infer temporal behaviour from structure checks — use the autoplay probe and budget ~30s of sampling — _auto cycle measured 5.65s hold-5.0s + 0.6s transition, seamless wrap at ~28s_ · hits=1 · 2026-10-18

## scale

- **P-029** fit a fluid value across its own clamp — fit the interior samples and clamp to the measured min/max — _a clamp(48px,10vw,140px) page came out as clamp(76.8px, calc(5.46px + 9.369vw), 140px)_ · hits=1 · 2026-10-18

## secrets

- **P-033** print, commit or pass an API token on the command line — read it from ~/.fidelity.json / env and log only ok|status — _a Figma and a Google Fonts key were pasted into chat and had to be treated as exposed_ · 2026-10-18

## selectors

- **P-024** anchor a component shot to a loose selector — prefer a stable child/ancestor and verify the shot dimensions first — _main > div silently captured the whole page or a 0×80 header strip_ · hits=1 · 2026-10-18

## shots

- **P-024** anchor a component shot to a loose selector — prefer a stable child/ancestor and verify the shot dimensions first — _main > div silently captured the whole page or a 0×80 header strip_ · hits=1 · 2026-10-18
- **P-025** keep a diff pair whose selector has no stable non-zero box — drop it and mask the region — _a 0-width wrapper kept failing while its children painted full width_ · hits=1 · 2026-10-18

## spec

- **P-027** emit a colour pair without checking contrast on every surface it can sit on — _muted text passed on surface and failed 4.4:1 on surface-alt (axe caught 6 nodes)_ · hits=1 · 2026-10-18
- **P-028** emit var(--x) without defining --x — a missing custom property kills the whole declaration — _--font-fallback was referenced by every font stack and never declared_ · hits=1 · 2026-10-18
- **P-029** fit a fluid value across its own clamp — fit the interior samples and clamp to the measured min/max — _a clamp(48px,10vw,140px) page came out as clamp(76.8px, calc(5.46px + 9.369vw), 140px)_ · hits=1 · 2026-10-18
- **P-030** assume BOM-free, CRLF-free input — strip a UTF-8 BOM before parsing JSON — _a spec.json saved by Notepad parsed as null and every downstream check was skipped_ · hits=1 · 2026-10-18

## structure

- **P-008** add a header, hero, cards, forms or extra copy because the layout "looks empty" — _invented blocks changed the composition_

## tokens

- **P-027** emit a colour pair without checking contrast on every surface it can sit on — _muted text passed on surface and failed 4.4:1 on surface-alt (axe caught 6 nodes)_ · hits=1 · 2026-10-18

## tooling

- **P-012** run ad-hoc Playwright scripts from outside scripts/ — ESM resolves packages from the script path, not cwd — _ERR_MODULE_NOT_FOUND: cannot find package playwright from a TEMP script_ · hits=1 · 2026-10-18
- **P-013** pass bracketed JS through node -e in PowerShell — write a temp .mjs and node --check it — _PowerShell ate the regex/brackets and the probe ran on a mangled string_ · hits=1 · 2026-10-18
- **P-016** start the dev server without preflighting a free port — _port 3000 was already taken by an unrelated process_ · hits=1 · 2026-10-18
- **P-022** parse PNGs with pngjs — use jimp; odiff's decoder reads files pngjs rejects — _"unrecognised content at end of stream" on Playwright element screenshots_ · hits=1 · 2026-10-18
- **P-030** assume BOM-free, CRLF-free input — strip a UTF-8 BOM before parsing JSON — _a spec.json saved by Notepad parsed as null and every downstream check was skipped_ · hits=1 · 2026-10-18
- **P-031** pipe a long-running node process into Select-Object -First N in PowerShell — it stops the pipeline and kills the process mid-run — _extract.mjs died after writing inventory ndjson and never wrote inventory.json, because the command ended in | Select-Object -First 3_ · 2026-10-18
- **P-033** print, commit or pass an API token on the command line — read it from ~/.fidelity.json / env and log only ok|status — _a Figma and a Google Fonts key were pasted into chat and had to be treated as exposed_ · 2026-10-18
- **P-034** treat --out as a directory when it is one — appending the filename only when the argument is not an existing dir — _judge.mjs call --out judge threw EISDIR because it opened the directory as the verdict file_ · 2026-10-18

## validation

- **P-015** ship a check type that accepts only one coordinate spelling — support x/left and y/top aliases — _boundingBox check rejected prop y and produced 4 phantom failures_ · hits=1 · 2026-10-18
- **P-035** normalize names coming from an external judge before matching (strip a trailing @width) — _the model answered hero@390 as both name and width and verify rejected a correct verdict as an invented region_ · 2026-10-18

## video

- **P-006** substitute a "similar" video or image for the pinned source — _a stock clip replaced the specified one_

## visual

- **P-011** rely on the capped whole-page inventory to prove text does or does not exist — do a dedicated subtree extraction — _the 400-element cap missed the hero DOM because its text was baked into banner images with load-bearing alt_ · hits=1 · 2026-10-18
- **P-019** report success after DOM checks with no visual comparison — _a green DOM run shipped a grey-gradient placeholder hero_ · hits=1 · 2026-10-18
- **P-020** replace brand art with a flat rectangle — rebuild the block as DOM with the same composition and mask what remains — _a flat placeholder lost the whole hero composition_ · hits=1 · 2026-10-18
- **P-021** diff whole pages — capture the same selector on both sides at the same viewport widths — _full-page screenshots can never align (different page furniture)_ · hits=1 · 2026-10-18

