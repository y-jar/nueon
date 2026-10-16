# Project Specification Document — nueon

The **living specification**: what the app is and does *now*, kept in sync with
the code. The original design brief is archived at `docs/history/PSD-v2.md`.

Rules:

- Each feature lists its **behaviour**, the **data** it touches, its
  **invariants**, **where it lives**, and **how it is proved** (a probe in
  `probes/probe.mjs`, a node test in `src/lib/**/*.test.ts`, or a cargo test in
  `crates/**`).
- Any stage that changes behaviour updates this document and the proof column in
  the same commit. The gate `scripts/check-headers.sh` keeps the per-file headers
  (and therefore `docs/MAP.md`) current; this document keeps the *why* current.

## What it is

A single-user conlang workspace app. A workspace is a plain folder holding:

- `notes/` — Markdown notes (`.md`) and other files (images, PDFs).
- `dictionary/` — one extensionless JSON file per word table.
- `config/` — extensionless JSON for grammar, translation, morphology, phonology.

Three tiers: `nueon-core` (Rust, no I/O beyond files + git CLI), the Tauri IPC
layer (`src-tauri/`), and the Svelte 5 frontend (`src/`). See `docs/ARCHITECTURE.md`.

---

## Workspace & storage

- **Behaviour.** Open/create a workspace; the file tree is shown in the sidebar.
  Everything is plain files under one folder so it is versionable and portable.
- **Data.** `dictionary/<table>`, `config/<name>`, `notes/**`. A `config.toml`
  registry (outside the workspace) remembers workspaces.
- **Invariants.** All writes are atomic; paths never escape the workspace root.
- **Lenient config.** A missing or unparseable `config/<name>` falls back to its
  default and surfaces a banner warning; it never prevents the workspace from
  opening.
- **Where.** `crates/nueon-core/src/workspace/storage.rs`, `src/lib/data.svelte.ts`.
- **Proof.** cargo `storage`/`workspace` tests; probe 32 (setup wizard).

## Notes editor

- **Behaviour.** Obsidian-style live preview: a single CodeMirror 6 view renders
  headings, bold/italic, links, code; GFM tables, task lists, footnotes; KaTeX
  math and HTML blocks render but reveal raw text under the cursor. `[[...]]`
  links highlight, follow on Ctrl/Cmd+click, and rewrite on rename.
- **Data.** `notes/<path>.md`; the dictionary word index for highlighting.
- **Invariants.** Autosave is debounced and never writes a stale buffer over a
  file that changed on disk (conflict detection).
- **Where.** `src/lib/editor/*`, `src/components/Editor.svelte`.
- **Proof.** probes 1–15, 35, 76–83; node `editor/*.test.ts`.

## Dictionary

- **Behaviour.** One grid per table with virtualized rows, sort/filter/hide per
  column, rich cell editors (tag pills, references, suggestions), multi-select
  and bulk edit, and a per-column context menu (sort, hide, change type, delete).
- **Data.** `dictionary/<table>`; each entry has a hidden UUID, a required
  `wordname`, and user-defined tags.
- **Invariants.** The UUID is stable across renames/re-imports; deleting a word
  with dependents prompts before acting.
- **Where.** `crates/nueon-core/src/model/dictionary.rs`, `src/components/Grid.svelte`.
- **Proof.** probes 29–31, 43–48, 56, 71–72, 96–97; cargo `model` tests.

## Etymology & derivation

- **Behaviour.** A word links to parents (roots); an inspector graph shows
  ancestors/descendants; deleting/editing a root warns and offers auto/manual
  convert or continue.
- **Data.** `parent` tag (a list of UUID references) on each entry.
- **Where.** `crates/nueon-core/src/model/derive*`, `src/components/DerivationGraph.svelte`.
- **Proof.** probe 48; cargo `derive` tests.

## Translation engine

- **Behaviour.** Clause-level: a drag-and-drop grid of tagged slots describes
  word order; an English sentence maps onto it via the dictionary, with a
  conflict picker for homographs and a gap for missing words.
- **Data.** `config/grammar` (rules), `config/translation` (settings, grids,
  affixes, table roles, morphology).
- **Where.** `crates/nueon-core/src/model/translate/`, `src/components/translation/`.
- **Proof.** probes 22–27; cargo `translate` tests.

## Morphology

- **Behaviour.** Fixes tables supply morphemes; ordered multi-slot affixes and
  feature/slot paradigms inflect words; a Compose builder combines roots; a
  preview shows the result before saving.
- **Data.** `config/translation.morphology`, `dictionary/<fixes table>`.
- **Where.** `crates/nueon-core/src/model/morphology*`, `src/lib/morphology.svelte.ts`.
- **Proof.** probes 57–70; cargo `morphology` tests.

## Phonology

- **Behaviour.** An IPA chart and a sound-change engine (ordered rules with
  find/replace, applied to a preview word and optionally to a whole table).
- **Data.** `config/phonology`.
- **Where.** `crates/nueon-core/src/model/phonology*`, `src/components/PhonologyView.svelte`.
- **Proof.** probe 79; cargo `phonology` tests.

## Import & export

- **Behaviour.** Import CSV/TSV/JSON into a table with column mapping; export a
  table to CSV/TSV/JSON or Anki; notes to PDF/ODT; the whole workspace/profile as
  a zip (and restore it).
- **Where.** `crates/nueon-core/src/import.rs`, `export.rs`; `src/components/import/`.
- **Proof.** probes 40, 56; cargo `import`/`export` tests.

## Version control

- **Behaviour.** Opt-in git in the workspace: idle auto check-in, status, diff,
  history and commit from the Source Control panel; remotes/push are deferred.
- **Where.** `crates/nueon-core/src/workspace/vcs*`, `src/components/GitPanel.svelte`.
- **Proof.** probe 37; cargo `vcs` tests.

## Tabs, splits & windows

- **Behaviour.** Per-pane tab groups with drag-to-reorder/split, torn-off
  secondary windows, persisted layout. Tabs reveal on activate, expose a title
  tooltip, `aria-selected` + roving tabindex with arrow/Home/End navigation,
  `Ctrl+Tab`/`Ctrl+PageDown`/`Ctrl+PageUp` cycling, middle-click and
  close-others/close-all-in-pane, and a `+` new-note button.
- **Where.** `src/lib/tabs.svelte.ts`, `layout.svelte.ts`, `src/components/TabBar.svelte`.
- **Proof.** probes 84–95; node `tabs.test.ts`, `tiling.test.ts`.

## Command palette

- **Behaviour.** `Ctrl+P` opens a palette listing recent notes and tables with
  quick actions.
- **Where.** `src/components/CommandPalette.svelte`.
- **Proof.** probe 80.

## Settings

- **Behaviour.** Language metadata, table roles, translator linting, and editable
  keybinds (with capture and reserved-combo refusal).
- **Where.** `src/components/Settings.svelte`, `src/lib/keybindings.ts`.
- **Proof.** probes 29, 33–34, 36, 42; node `keybindings.test.ts`.

## Wiki links

- **Behaviour.** `[[target]]`, `[[target|alias]]`, `[[target#heading]]` and `!`
  embeds; a ranked autocomplete (words and notes, Fixes ranked below vocab);
  brackets hide until the cursor touches them; a `Mod+Shift+L` keybind wraps a
  selection; `Enter` exits a link.
- **Where.** `src/lib/wikilink.ts`, `src/lib/editor/wikiLinks.ts`.
- **Proof.** probes 76–87; node `wikilink.test.ts`, `editor/wikiLinks*.test.ts`.

## Internationalization

- **Behaviour.** All chrome strings come from `src/locales/en.json` via
  svelte-i18n; the language is a workspace setting.
- **Where.** `src/lib/i18n.ts`, `src/locales/`.
- **Proof.** (no automated proof — noted gap.)

## Scripting (design only)

- **Where.** `docs/SCRIPTING.md`. Not implemented.

## Writing System (in progress)

- **Behaviour.** A tab for designing the conlang's writing system: draw glyph
  vectors in a vector editor, map them to the phonology's phonemes, preview
  words in the script (in the translator and glossing views), and export a font
  (`.ttf`/`.otf`), SVG, plus a JSON profile. Includes a tree navigator + glyph
  grid, a radical palette, a CJK-style composition matrix, and a pathfinder.
  Glyphs may reference other glyphs as component instances (radicals), kept
  acyclic and flattened only for pathfinder/CFF.
- **Data.** `config/writing` (the writing config: direction, metrics, glyph
  index and grouping, orthography rules, GSUB feature text) and
  `writing/glyphs/<id>` (one glyph outline per file). Joins `Profile` v3, which
  carries the config but not the outline vectors.
- **Invariants.** Phonemes carry a stable `id` (backfilled on load) so glyph
  mappings survive a symbol rename; the component graph is acyclic and every
  reference resolves; glyph writes are atomic and validated.
- **Where.** `docs/WRITING-SYSTEM.md` (design proposal). Stage 1 — data model,
  storage, `Profile` v3 and `Phoneme.id` — is implemented in
  `crates/nueon-core/src/config/writing_system.rs` and
  `crates/nueon-core/src/workspace/writing.rs`. Stage 2 — the singleton
  `writing` tab, the glyph navigator tree, the glyph grid, and the `glyph`
  context menu — is implemented in `src/components/WritingSystemView.svelte`,
  `GlyphNavigatorTree.svelte`, `GlyphGrid.svelte` and `GlyphTile.svelte`,
  with `src/lib/writing.ts` for the pure grouping/coverage logic. The vector
  editor shell — toolbox, canvas with typographic guide rails, glyph metrics
  panel, radical palette, composition matrix, pathfinder panel and the bottom
  glyph tray — is implemented in `src/components/VectorEditor.svelte` and its
  children, backed by `src/lib/writingEditor.svelte.ts`. Drawing is real: pen
  (click, drag for handles, close on the first node), direct select, node mod,
  shapes, calligraphic brush (fixed-angle nib, mouse input), mirror/flip,
  eraser/knife, scale/rotate/shear, align/distribute and layer order, all as
  pure operations in `src/lib/writingCommands.ts` with an undo/redo stack
  (`src/lib/history.ts`) that is separate from git. The menu bar
  (`EditorMenuBar.svelte`, definitions in `src/lib/writingMenus.ts`) provides
  File, Edit, View, Tools, Metrics (guide heights saved to `config/writing`),
  Glyphs and Export dropdowns. Placement snaps (`src/lib/writingSnap.ts`) to
  existing nodes first, then guide rails, the x=0 line, the advance line,
  segment midpoints and the grid, within 10 screen pixels (`10/zoom` units);
  Shift disables snapping. Dragging an open endpoint onto another open
  endpoint shows a green "release to weld" cue and joins them on drop; Shift+J
  joins two selected endpoints, Shift+B breaks a node. Delete removes a node
  but keeps the curve's shape, Ctrl+Delete removes it plainly. Arrow keys nudge
  1 unit (Shift 10), Tab/Shift+Tab step through nodes, V is the default
  Select tool (whole shapes: click, Shift-click, box, drag, Ctrl+D, Delete),
  a type preview (text set in the script, shaped by the same font the export
  writes, 12 to 300 px, typed text / lexicon words / all glyphs / pairs, metric
  lines and advance boxes, and a gap drag that edits the neighbouring bearings),
  hover descriptions on every tool and widget (audited by a probe across the
  grid, spacing mode, preview and editor),
  a knife (K: cut a contour exactly where clicked, shape-preserving by de
  Casteljau subdivision, one undo step), a measure tool (R: a dashed line and
  the info bar's distance/angle while dragging, no edits, works with the fore
  layer hidden) and freehand drawing (F: the raw stroke previews, on release a
  fitted open path within 2 units, at most 12 nodes, Catmull-Rom handles,
  worst-point refinement, a straight stroke becomes its two ends),
  layers (guide/back/fore visibility toggles in the toolbox and View menu; a
  tracing image per glyph imported into `writing/assets/`, placed in font units,
  selected, moved and corner-scaled with the aspect kept, one undo step per
  gesture, cleared by Delete with the file kept for undo, swept when the glyph
  is deleted, never in the font, the key or the export; a hidden fore layer
  blocks editing),
  spacing (derived bearings, draggable bearing lines in the editor, a grid
  Spacing mode with a test-pair popover, copy-from and batch bearings, undo),
  Shift snapping (alignment with other nodes, 45/135 degree lines, clean node spots
  in Node Mod, centre-of-line drag), a glyph grid of boxed cells (real outline and advance box per cell, label
  above, faint X slots for sounds with no glyph, S/M/L and slider sizes, filters,
  a "N of M glyphs drawn" progress line, virtualised for 500+ glyphs), a clearer
  visual language (square/circle/diamond nodes with crosses, X-marked
  handles in teal for the incoming and magenta for the outgoing side, labelled
  guide rails, advance box, start arrows, open-end caps) and an info bar (cursor,
  drag distance and angle, zoom, tool, layer), Bezier editing in the Direct tool (handles only for selected nodes and
  their facing neighbours, node-over-handle hit priority, drag a segment to
  reshape it, Alt-pull symmetric handles, double-click toggles corner/smooth,
  Shift/Ctrl handle constraints, add extrema), a transform box on selected shapes (corner scale, outside-corner rotate,
  edge skew, draggable pivot; one undo step per drag), Edit > Transform... with
  numeric move/scale/rotate/skew and copy, Corner/Smooth/Symmetric node types
  (buttons, menu, drawn shape), H Hand and Z Zoom tools (viewport model with zoom about the cursor,
  0.1 to 32), the toolbox is grouped with icons and tooltips, a rubber band selects
  nodes, Ctrl constrains drags to an axis and handles to 15 degrees, Alt keeps
  a handle's length, Space or middle-drag pans and Ctrl+wheel zooms. Component
  instances are drawn on the canvas as tinted, dashed shapes with their
  transform applied (`src/lib/writingComponents.ts`, mirroring the backend's
  scale, rotate, translate order and surviving cycles and missing glyphs);
  Direct Select picks one, Delete removes it, and Edit/Tools > Expand component
  (Ctrl+Shift+E) replaces it in place with editable contours; SVG export/import and multi-select batch actions
  (group, advance width, export, delete) are wired. Pathfinder booleans are in
  `crates/nueon-core/src/model/pathfinder.rs` (`flo_curves`, curve-preserving)
  and component flattening in `crates/nueon-core/src/workspace/writing.rs`.
  TrueType export is built: `crates/nueon-core/src/font/` converts cubic
  outlines to quadratics (`kurbo`), writes `head hhea maxp OS/2 hmtx cmap glyf
  loca name post` (`write-fonts`), maps each glyph to its Private Use
  codepoint, flattens components into real contours, and verifies the result by
  reading it back (`read-fonts`) before it is written; duplicate codepoints and
  an empty system block the export. A pre-export check
  (`crates/nueon-core/src/font/validate.rs`, shown by Export > Check font and
  before every export in `FontReportDialog.svelte`) lists, per glyph, errors
  (duplicate or invalid codepoints, points beyond +/-32767), warnings (open
  contours, contours under 3 points, self-intersection, even-odd fill, empty
  glyph, duplicate glyph names, which the rules editor resolves by name) and notes (counter-clockwise winding,
  points rounded to the integer grid); only errors block, and the compiler
  reverses every contour of a counter-clockwise glyph together so the filled
  shape and its holes are unchanged. Orthography rules compile to a GSUB `calt` feature
  (`crates/nueon-core/src/font/layout.rs`), so typing the rules' letters in
  any application renders the glyphs: each rule becomes one lookup in the
  order written (a single, multiple or ligature substitution, wrapped in a
  chaining context when it has a left or right context), so an earlier rule
  acts before a later one. `C`, `V` and `L` in a context are read from the
  sound inventory (the last letter of a sound on the left, the first on the
  right), `#` matches a space, and a context that looks backwards also accepts
  the glyph an earlier rule produced for that letter. Letters that have no
  glyph of their own get a hidden empty glyph so they can be typed. The rules
  are edited in the writing tab (`OrthographyRules.svelte`, helpers in
  `src/lib/writingRules.ts`); rules that cannot work (unknown glyph, several
  letters to several glyphs, an empty class) are skipped and reported in the
  font check, and an unknown glyph blocks the export. Joining scripts are supported through per-glyph
  positional forms (`GlyphMeta.forms`: initial, medial, final alternates by
  glyph id, set in the glyph metrics panel): a glyph with any form joins its
  neighbours, and the same `calt` feature swaps it for its initial form at the
  start of a run, medial in the middle, final at the end, and leaves it alone
  when nothing joins to it. A space or a glyph with no forms ends a run. Forms
  that point at a missing glyph block the export, and forms that can never
  apply are reported. OpenType (CFF) export and translator preview are not yet
  built.
- **Proof.** cargo `writing_system`, `profile`, `pathfinder` and `workspace`
  tests (type round-trips, profile v1/v2/v3 backfill, phoneme-id backfill,
  acyclic-component rejection, glyph atomic save/load, SVG serialization,
  curve-preserving booleans, component flattening, SVG export/import
  round-trip, font compilation read back through `read-fonts`, and verified
  against FreeType via fontconfig and ImageMagick: the exported circle glyph
  rendered with 0.785 ink coverage, pi/4, so curves survive the cubic to
  quadratic conversion); node `tabs.test.ts` (`isSingletonTab("writing")`),
  `writing.test.ts` (glyph grouping, sound coverage, tool registry, guide
  rails, bounds, path data), `writingCommands.test.ts` (node/handle edits,
  shapes, transforms, align/distribute, layer order, brush), `history.test.ts`,
  `writingMenus.test.ts`, `writingBatch.test.ts`, `layout.rs` tests that compile a font and shape it through `harfrust` (ligatures,
  one-to-many, left/right/class/boundary contexts, rule order, multi-letter
  sounds) and were cross-checked against C HarfBuzz `hb-shape` on the same
  bytes, `writingRules.test.ts`, `writingViewport.test.ts` (screen/glyph transforms, zoom about a point,
  pan, zoom-to-rectangle, fit, viewBox), `writingSelect.test.ts` (hit testing,
  marquee, move, nudge, duplicate), tool registry and shortcut-conflict tests
  in `writing.test.ts`, `writingTransform.test.ts` (matrix order, scale/rotate/skew about a pivot,
  Shift/Alt, handle hit rules, component folding, dialog order, copy) and
  `writingNodeType.test.ts` (handle growth, symmetric/smooth lengths, open ends),
  both mutation-checked, `writingLayers.test.ts` (layer toggles, the
  hidden-fore edit block, the image rectangle, corner hits, corner scaling
  with the anchor and aspect and the min clamp; every mutation caught),
  `writingFreehand.test.ts` (straight collapse, quarter/half circle budgets, cap,
  order and clean ends, short strokes; every mutation caught or justified),
  `knifeCutAt` tests in `writingCommands.test.ts` (exact shape preservation by
  de Casteljau correspondence, open/closed/node/boundary/wild-t cases),
  `typePreview.test.ts` (size range, placement and wrapping, sample text, gap hit
  and drag; mutation-checked), Rust tests for `shape.rs` (cross-checked with
  `hb-shape`), the preview font equalling the exported font, the font key and the
  preview cache, and `writingSpacing.test.ts` (bearings from ink, left/right/advance edits, line hit
  and drag, cell geometry, pair layout) and `spacingHistory.test.ts`, both
  mutation-checked, a Rust test that reads the compiled font's `hmtx` back, and
  `writingSuggest.test.ts` (clean spots, alignment and angle targets, claim
  precedence, insertion choice, centre drag; mutation-checked) and
  `writingGrid.test.ts` (cell view box, filters, empty slots, progress, columns,
  virtual window, reload guard) and `outlineCache.test.ts` (dedupe, concurrency,
  invalidation, retry), both mutation-checked, `writingInfo.test.ts` (guide labels, coordinate/angle/zoom formatting, drag
  readout, contour direction, start direction, open ends; mutation-checked),
  `writingBezier.test.ts` (segment drag keeps the point under the pointer and
  the end nodes fixed, smooth/symmetric stay constrained, visible-handle rules,
  hit priority and radii, extrema keep the shape and land on extremes;
  mutation-checked), `writingForms.test.ts`, positional-forms tests (runs,
  breaks, missing forms, rules combined) cross-checked against `hb-shape` on
  ten shaped strings, `validate.rs` tests (winding, reversal keeps holes and handles, bow-tie
  detection, names, duplicates, range), `fontReport.test.ts`, a compile test
  reading the glyph back to prove clockwise output, `writingComponents.test.ts` (transform order, handles, nested/cyclic
  flattening, dependency list, expand in place), `writingSnap.test.ts` (snap
  priority and radius, weld candidates, angle/axis constraint) and the weld,
  join, break, shape-preserving delete, nudge and box-select cases in
  `writingCommands.test.ts`.
