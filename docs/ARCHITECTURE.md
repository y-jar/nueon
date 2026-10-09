# Architecture

nueon is a Linux desktop app built as three layers, so the domain logic is
testable and reusable independently of any UI:

1. **`nueon-core`** — a UI-agnostic Rust crate: the data model, on-disk
   storage, configuration, translation engine, and git integration.
2. **Tauri IPC** (`nueon-tauri`, in `src-tauri/`) — a thin command/service
   boundary over the core, plus window/bundle concerns.
3. **Svelte 5 frontend** (`src/`) — the UI: a Svelte 5 runes store, CodeMirror 6
   editor, and the grid/translation/import/export components, talking to the
   core only through `invoke()` wrappers.

## Repository layout

```
Cargo.toml                     # Cargo workspace
crates/nueon-core/             # tier 1: domain logic
  src/model/                   # tables, tags, entries, fields, derivation, translate
  src/workspace/               # loading, storage, assets, trash, filenames
  src/config/                  # language, grammar, translation, settings, layout
  src/import.rs                # delimited import (detect/preview/apply)
  src/export_table.rs          # table export (CSV/TSV/JSON)
  src/export.rs                # Markdown → HTML/ODT
  src/translation/mod.rs       # syntax-grid/clause-slot model (runner is model/translate.rs)
  src/vcs/                     # git CLI integration + auto-check-in
  src/global.rs                # global (cross-workspace) config
src-tauri/                     # tier 2: Tauri v2 shell
  src/commands/                # one module per command group
  src/state.rs                 # Mutex<AppState>
  src/tree.rs                  # notes-tree scan
  tauri.conf.json              # window, bundle (appimage/deb/rpm)
src/                           # tier 3: Svelte 5 frontend
  lib/api.ts                   # typed invoke() wrappers + DTOs
  lib/state.svelte.ts          # runes store (tabs, groups, ui, data)
  lib/i18n.ts                  # translation helper
  locales/en.json              # UI strings
  lib/editor/                  # CodeMirror extensions (live preview, theme)
  components/                  # shell, grid, editor, import wizard, export…
flake.nix                      # packages.default (source) + nueon-bin (prebuilt)
.github/workflows/release.yml  # tag-driven Linux release builds
packaging/nueon.desktop        # launcher entry
```

## Tier 1 — `nueon-core`

The authoritative domain model:

- A **workspace** is a plain directory:
  - `notes/` — Markdown files (`.md`; folders allowed).
  - `dictionary/` — one JSON file per word table.
  - `config/` — `language`, `grammar`, `translation`, `settings` (JSON).
  - `assets/` — imported images/files, named by content hash.
  - `.trash/` — recoverable deletions, git-ignored.
  - `.git/` — optional; git is opt-in.
- A **table** is a bin of words; a word lives in exactly one table.
- A **tag** is a column of a table (`wordname` builtin; `definition` and
  `parent` reserved; others are user tags with a `FieldType`).
- **Sparse words**: a tag is stored only once it has a value.
- **Etymology** is multi-parent (`parent` is a `References` list, a DAG);
  traversals are cycle-safe.

### Translation and morphology

- `model/translate.rs` tokenizes English, matches conlang roots by `definition`
  (light lemmatization + rule-based affixes), places them in a syntax grid or
  word for word, and reports gaps.
- `config/morphology.rs` holds feature definitions and per-class paradigms. A
  paradigm is **ordered slots** (`ParadigmRow::slot`/`order`); the most-specific
  matching rule wins per slot, then affixes compose around the stem as a prefix,
  infix (inserted after the first vowel), or suffix. A row carries an inline
  `surface` or references a `Fixes`-table morpheme (`morpheme`), so the table is
  the single source of truth for the form.
- `Fixes` tables feed both input parsing (`dictionary_affixes`, prefix/suffix
  english triggers) and output inflection (`dictionary_morphemes`).
- The **Morphology** activity (`MorphologyPanel`/`MorphologyView`) authors
  features and endings and previews a single word: `inflect_word` composes the
  feature-driven paradigm affixes with any manually picked fixes-table
  morphemes and returns the surface plus an ordered breakdown.

### Storage rules

- Every write is **atomic** (temp file + rename).
- Workspace paths are never escaped: `safe_join` rejects `..`/absolute paths;
  trash restore and import go through the same guard.
- Renames/moves and asset/note imports are **no-clobber** (a hard link, or an
  exclusive create, followed by a rename).
- Table filenames are resolved **once** and kept stable, so names that slugify
  alike (`Roots`/`roots`, `a b`/`a_b`) never collide; a tolerant scan skips
  `.tmp` files, quarantines unreadable files in place, and never fails the load.
- Deletions go to `.trash/<timestamp>-<uuid>/` with a manifest; undo/redo only
  ever writes or trashes files the app owns.

### Import and export

- `import.rs` — `detect` (guesses delimiter/header/roles), `import_preview`
  (read-only report: rows, links, duplicates, warnings), and `import_apply`
  (two passes: create words, then resolve `[[…]]` links into `parent` or any
  reference tag). Empty cells write no tag; cycles are rejected.
- `export_table.rs` — `export_table(table, Csv|Tsv|Json)`: delimited output is
  the inverse of the importer (round-trip tested), JSON is a lossless snapshot.
  `export_anki(table, &AnkiExportOptions)` writes an Anki-importable text file
  (file headers for separator/notetype/deck/columns, a tags column from boolean
  flags, and a stable GUID column for update-in-place re-imports).
- `export.rs` — Markdown → HTML (for PDF printing) and a hand-built ODT writer.

## Tier 2 — Tauri IPC (`nueon-tauri`)

- **State**: `Mutex<AppState { global: GlobalConfig, workspace: Option<Workspace>, … }>`,
  managed by Tauri; every command locks it (read-only commands lock immutably).
- **Errors** are mapped to strings across the IPC boundary.
- **DTOs** are the core's serde types; the frontend mirrors them in
  `src/lib/api.ts`.

Command groups (see `src-tauri/src/commands/`):

- app (`ping`)
- workspace registry & lifecycle (`workspace_list`, `workspace_current`,
  `workspace_open`, `workspace_create`, `workspace_remove`, `workspace_rename`,
  `workspace_set_path`, `workspace_delete_from_disk`)
- config (`config_get`, `config_set`)
- layout (`layout_get`, `layout_set_git_panel`, `ui_layout_get`,
  `ui_layout_set`, `layout_state_get`, `tiling_save`)
- notes (`list_workspace`, `read_note`, `save_note`, `create_note`,
  `create_note_with_content`, `create_folder`, `move_or_rename_note`,
  `delete_note`, `note_count`)
- trash (`trash_list`, `trash_restore`, `trash_purge`, `trash_empty`)
- dictionary (`list_tables`, `get_table`, `create_table`, `delete_table`,
  `rename_table`, `word_index`, `quarantine_warnings`, word CRUD
  (`create_word`/`save_word_entry`/`set_word_value`/`set_word_definition`/
  `rename_word`/`delete_word`/`move_word`), tag management
  (`add_tag`/`remove_tag_preview`/`remove_tag`/`set_tag_kind`/`set_tag_format`/
  `known_tag_names`))
- history (`history_status`, `undo`, `redo`, `warning_dismissed`,
  `dismiss_warning`)
- etymology (`set_parent`, `remove_parent`, `reparent_word`,
  `parent_candidates`, `derivation_tree`, `derivation_graph`)
- grid view state (`grid_view_get`, `grid_view_set`)
- import/export (`import_detect`, `import_preview`, `import_apply`,
  `export_table`, `export_anki`, `export_document`, `import_asset`,
  `import_drop`)
- translation (`list_presets`, `save_preset`, `delete_preset`,
  `execute_translation`, `create_translation_word`, `translation_options`,
  `set_translation_options`, `export_presets`, `import_presets`)
- morphology (`translation_morphology`, `set_translation_morphology`,
  `list_morphemes`, `lexicon`, `inflect_word`)
- phonology (`phonology_check_words`, `phonology_segments`)
- version control (`vcs_*` and `git_prompt_dismissed`/
  `git_prompt_dismissed_set`, `autocheckin_*`)
- windows (`window_spawn`, `window_close_self`, `windows_restore`)

**Events**: the backend emits `data-changed` with a `scope`
(`workspace`/`notes`/`dictionary`/`config`/`translation`/`vcs`); the frontend
reacts by refetching the affected slice.

## Tier 3 — Svelte 5 frontend

- `src/lib/state.svelte.ts` is the single runes store: workspace/registry data,
  notes tree, tables, the tab-group/split layout, the editor document state,
  and shell UI flags. Components read/mutate it directly.
- `src/lib/api.ts` holds typed `invoke()` wrappers and the DTO interfaces
  mirroring the Rust serde types.
- The shell (`App.svelte`) composes an activity ribbon, a sidebar host
  (notes/tables/git), a recursive split view of tab groups, the inspector, the
  import wizard modal, trash/settings modals, and the export/definition grid.
- The editor is CodeMirror 6 with a Markdown live preview, KaTeX, dictionary
  highlighting, and a formatting toolbar; notes autosave with dirty tracking
  and disk-conflict detection.

## Testing

Three tiers: pure `node:test` unit tests (`npm run test`), `cargo test` for the
core, and packaged UI probes via `probes/probe.mjs` (`npm run probe`). The
methodology, templates, and gotchas live in
[`docs/PROBING.md`](PROBING.md).

## Packaging & release

- `flake.nix` exposes `packages.default` (built from source) and
  `packages.nueon-bin` (fetches a published `.deb` and patches it for Nix).
- `tauri.conf.json` enables the AppImage, deb and rpm bundler targets.
- `.github/workflows/release.yml` builds those bundles on Ubuntu 22.04 and
  24.04 for any `v*` tag and publishes a GitHub Release.
