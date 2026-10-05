# Architecture

langloom is a **Tauri v2** desktop app: a Rust backend (the reusable
`langloom-core` domain crate) and a **Svelte 5 + CodeMirror 6** frontend.

## Repository layout

```
Cargo.toml                     # Cargo workspace
crates/langloom-core/          # UI-agnostic domain logic (model, config, global, translation, vcs, workspace)
src-tauri/                     # Tauri v2 shell: state, commands, capabilities
src/                           # Svelte frontend
  lib/api.ts                   # typed invoke() wrappers + DTOs
  lib/editor/                  # CodeMirror extensions (live preview, dictionary, theme)
  App.svelte                   # three-pane shell
flake.nix                      # dev shell + packaged app
packaging/langloom.desktop     # launcher entry
docs/                          # this spec, PSD.md, code ideas
```

## Domain model (authoritative, in `langloom-core`)

- A **workspace** is a plain directory with three subdirectories:
  - `notes/` — **extensionless raw plain-text/Markdown** files (folders allowed).
  - `dictionary/` — one **extensionless JSON** file per word table.
  - `config/` — per-conlang **extensionless JSON** (`language`, `grammar`,
    `translation`, `settings`).
- A **table** is a logical bin of words; a word lives in exactly one table.
- A **tag** is a column of a table (per-table scope). `wordname` is the builtin
  tag; `definition` (English senses) and `parent` (etymology links) are reserved.
- **Sparse words**: a word only stores a tag once a value is applied.
- **Homographs** are distinguished by hidden UUIDs.
- **Etymology is multi-parent**: `parent` is a `References` list
  (`FieldValue::References(Vec<Uuid>)`), forming a DAG. Traversals are
  cycle-safe; deleting a word can unlink it from its direct children.
- **Git is opt-in**; auto-check-in is an idle-debounced commit (default 60 s).

## Backend (Tauri)

- **State**: `Mutex<AppState { global: GlobalConfig, workspace: Option<Workspace>, auto: AutoCheckin }>`
  managed by Tauri; every command locks it.
- **Errors**: domain errors (`StorageError`, `VcsError`, global-config errors)
  are mapped to a serialized `{ code, message }`.
- **DTOs** are the `langloom-core` serde types; the frontend mirrors them in
  `src/lib/api.ts`.

### Commands

Notes & filesystem (extensionless plain text):
`read_note`, `save_note`, `list_workspace` (tree), `create_note`,
`create_folder`, `move_or_rename_note`, `delete_note`.

Dictionary (extensionless JSON):
`list_tables`, `get_table`, `create_table`, `delete_table`, `save_word_entry`,
`delete_word_entry`, `add_tag`, `remove_tag_preview`, `remove_tag`,
`set_parent`, `remove_parent`, `parent_candidates`, `list_tags`, `search`.

Etymology:
`get_derivation_tree` (`{ ancestors, children, descendants }`),
`resolve_derivation_update` (`Cancel | AutoConvert | Manual | ContinueAnyway`).

Editor aid (low-latency, non-blocking):
`get_word_hover_card` (homograph-aware, returns all matches),
`get_conlang_autocomplete_tokens`.

Translation:
`list_presets`, `save_preset`, `delete_preset`, `execute_translation`,
`create_translation_word`.

Config & settings: `get_config`, `set_config`.

Version control: `vcs_status`, `vcs_log`, `vcs_diff`, `vcs_show`, `vcs_commit`,
`vcs_init`, `vcs_revert_file`, `autocheckin_set`, `autocheckin_pump`.

Workspace registry: `workspace_list`, `workspace_current`, `workspace_open`,
`workspace_create`, `workspace_remove`, `workspace_rename`,
`workspace_set_path`, `workspace_delete_from_disk`.

### Events (backend → frontend)

- `data-changed` with a `scope` (`notes | dictionary | vcs | config |
  workspace | translation`) — the frontend refetches the affected view.
- `workspace://file_changed` — emitted by a future file watcher when an external
  process modifies files on disk.

## Frontend (Svelte 5)

- Three panes: **sidebar** (bottom-pinned workspace switcher; notes tree; tables;
  presets), **center tabs** (CodeMirror editor / dictionary grid / translation),
  **inspector**.
- **Live Preview** is implemented in CodeMirror 6 with range decorations: markdown
  syntax is concealed/replaced on every line **except the line under the
  cursor**, which shows raw text. Native selection, no layout shift.
- **Dictionary grid** uses TanStack Table (headless) with client-side
  sort/filter/search over dynamic, user-defined columns.
- **Translation builder** is web drag-and-drop over the `SyntaxGrid`/`ClauseSlot`
  model.

## Environment

`shell.nix` provides Rust, Node 22, and the WebKitGTK/GTK3 native libraries Tauri
needs, exports `LD_LIBRARY_PATH`, and sets
`WEBKIT_DISABLE_DMABUF_RENDERER=1` / `WEBKIT_DISABLE_COMPOSITING_MODE=1` for
reliable Wayland rendering. A reproducible Nix flake for packaging lands at R8.

## Packaging (`flake.nix`)

- `devShells.default` provides Rust, Node 22, and the WebKitGTK/GTK runtime
  libraries, with `LD_LIBRARY_PATH` and the Wayland-safe WebKit env vars.
- `packages.default` is a `rustPlatform.buildRustPackage` derivation:
  - the frontend is built first with `buildNpmPackage` (lockfile-pinned
    `npmDepsHash`) and copied to `dist/`, which Tauri embeds at compile time;
  - `wrapGAppsHook3` + `autoPatchelfHook` wire the GTK/WebKit runtime, and the
    wrapper bakes in `WEBKIT_DISABLE_DMABUF_RENDERER=1` and
    `WEBKIT_DISABLE_COMPOSITING_MODE=1` via `gappsWrapperArgs`;
  - the `.desktop` file and 32/128/256 px icons are installed under
    `$out/share/{applications,icons/hicolor/...}`.

## Migration stages

R0 workspace split · R1 toolchain + Tauri scaffold + shell · R2 registry + notes
tree · R3 CodeMirror Live Preview · R4 grid + inspector · R5 translation · R6 git
panel · R7 tree DnD + constructs · R8 packaging + legacy purge. **Complete.**
