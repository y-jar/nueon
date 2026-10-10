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
