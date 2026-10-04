# langloom

A super awesome conlang editor and creation app.

Data model, storage layer, version-control integration, and workspace
scaffolding live here. See [`docs/PSD.md`](docs/PSD.md) for the full
specification.

## Concepts

- **Table** — a user-created, independent bin of words (like a folder). Stored
  as one extensionless JSON file. A word lives in exactly one table.
- **Tag** — a column of a table. Tags are scoped per table (not shared), but
  the app suggests previously-used names when adding one. `wordname` is the
  builtin starting tag; `definition` and `parent` are reserved optional tags.
- **Sparse words** — a word only stores a tag once a value is applied. Absent
  tags are null, and no empty tags are ever written.

## Workspace layout

A workspace is a plain local directory the user picks:

```
<workspace>/
├── notes/            # raw Markdown, extensionless, folders allowed
├── dictionary/       # one extensionless JSON file per table
│   ├── all_words     # { "name": "all words", "tags": [...], "entries": [...] }
│   └── verbs
├── config/
│   ├── language      # metadata (name, author, script, direction)
│   ├── grammar       # named GrammarRule patterns over tag names
│   ├── translation   # settings + saved SyntaxGrids
│   └── settings      # auto-checkin toggle + interval
├── .gitignore        # *.tmp, internal state
└── .git/             # optional, opt-in
```

## Workspaces

The app keeps an app-global registry of workspaces at
`$XDG_CONFIG_HOME/langloom/config.toml` (fallback `~/.config/langloom/`),
listing each workspace's display name and path plus the last-opened one. The
bottom of the left sidebar has a workspace switcher; its last entry opens the
**Manage workspaces** wizard, where you can create a new workspace (name +
destination), open an existing folder (empty folders are scaffolded with
`notes/`, `dictionary/`, `config/`, and `.gitignore`), or edit/remove registered
ones. With no workspace open, an onboarding screen links to the same wizard.

## Version control

Git is opt-in. On open the app detects `Ready`, `NotARepo`, or
`GitNotInstalled` and prompts accordingly. When enabled, changes are written to
disk immediately and **auto-checked-in after 60s of idle** (configurable), plus
manual check-ins from the git side panel. Removing a tag strips its values and
commits `DELETED TAGS: ... <CAN REVERT>` so the change is revertible.

## Interface

An egui/eframe desktop app with a fixed three-pane layout around a dockable
tab area:

- **Top command bar** — omni-search (`tag:` / `def:` prefixes) and the
  Source Control toggle.
- **Left sidebar** — a notes folder tree (create/rename/delete notes and
  folders), dictionary tables, and translation presets; create tables.
- **Center dock** — Welcome, a live-preview Markdown note editor, and an
  editable Dictionary grid (add words/tags, inline text/boolean edits, delete,
  inspect).
- **Right inspector** — details for the selected word or note, including its
  etymology: multiple root/parent words (add/remove with a cycle-safe picker),
  ancestors, direct derivatives, and dependent counts.
- **Source Control panel** — status, commit box, and history; git prompts on
  first open, plus an auto check-in toggle.

### Dictionary grid

A builtin `parent` column follows `wordname`, then the table's tags. Left-click
a column header to sort (repeat toggles ascending/descending, a third time
clears); right-click for a menu to filter (has/no value, true/false, hide
column, remove tag); the search icon opens a per-column "contains" search.
A "Columns" menu unhides columns, "Clear filters" resets the view, and the
header shows `showing N of M`.

### Etymology

A word may list multiple `parent` words (a DAG). Renaming or deleting a word
with dependents raises a warning with four options: Cancel, Auto-Convert
(rename: substring replace across descendants; delete: unlink the deleted word
from its children), Manual (bulk editor), or Continue Anyway (keep the link,
shown as "(missing)" if dangling).

### Notes editor

Notes render as rich Markdown (headings, lists, quotes, code, bold/italic/
inline code/links). Click a rendered block to reveal and edit its raw syntax;
the rest stays rendered. `Ctrl+E` toggles whole-note raw mode. Edits are
autosaved immediately; version-control check-ins remain gated on git being
opted in and the auto check-in toggle.

Words that exist in the dictionary are tinted; hovering shows a tooltip with
their senses and table, and **Ctrl+click** selects the word in the Inspector.
Homographs display a superscript (`word¹`). Markdown links are clickable and
open in the browser. Each note remembers its scroll position.

Keyboard: `Ctrl+K` search, `Ctrl+S` save note, `Ctrl+E` raw/rendered toggle,
`Ctrl+T` translation, `Ctrl+Shift+G` toggle Source Control.

### Translation builder

The Translation tab builds a clause structure by dragging tags from the palette
into ordered slots (drag to reorder, or use the up/down buttons). Slots can be a
required tag (`#Subject`), a literal particle, a wildcard, or a spacer for
between-word rules. Presets are named, saved, and loaded from
`config/translation`.

### Translation execution

Below the builder, enter an English sentence and press **Translate**. Words are
matched to entries by their `definition` (exact, then substring), assigned to
slots by tag, and emitted as conlang text. Adjacent words are auto-spaced by
the configurable separator; literals attach directly. Ambiguous words
(homographs) require choosing a meaning; missing words and unfilled required
slots are reported.

Missing words can be created inline: type a conlang spelling, pick the target
table (global default with per-word override), tick tags (undeclared tags are
added as Boolean columns), and **Create**. The word is saved and the
translation re-runs immediately.

## Development

> **Migration in progress:** the app is moving from egui to **Tauri v2 + Svelte 5
> + CodeMirror 6**. The reusable Rust core lives in `crates/langloom-core`; the
> interim egui UI lives in `crates/langloom-egui` and will be removed once the
> Tauri UI reaches parity.

Everything is provided by the Nix shell (Rust + Node 22 + Tauri's WebKit/GTK
libraries). The Tauri shell is at `src-tauri/` with the Svelte frontend in
`src/`; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```sh
nix-shell
npm install
npm run tauri dev        # launch the Tauri + Svelte app

cargo test -p langloom-core          # core logic (UI-agnostic)
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

Run the interim egui app against a workspace directory (defaults to
`$XDG_DATA_HOME/langloom` or `~/.local/share/langloom`):

```sh
cargo run -p langloom-egui -- /path/to/workspace
cargo run -p langloom-egui -- --check /path/to/workspace   # headless summary
```

## Roadmap

Legacy egui UI (kept as a reference until the Tauri port is complete):

- [x] Three-pane shell, docked tabs, dictionary grid, git panel
- [x] Block live-preview Markdown editor (click-to-reveal, autosave)
- [x] Etymology/derivation DAG, parent picker, dependency warnings
- [x] Grid column sort / filter / per-column search / visibility
- [x] Translation builder + execution + inline missing-word creation
- [x] Notes sidebar tree + workspace registry + switcher + manage wizard

Tauri v2 + Svelte 5 + CodeMirror 6 (current effort):

- [x] R0 — Cargo workspace split (`langloom-core` + legacy `langloom-egui`)
- [x] R1 — Toolchain + Tauri scaffold + blank three-pane shell
- [x] R2 — Registry + notes tree
- [x] R3 — CodeMirror Live Preview editor
- [x] R4 — Dictionary grid + inspector
- [x] R5 — Translation builder + runner
- [x] R6 — Git panel + auto-check-in
- [ ] R7 — Tree DnD + constructs (images/tables/task lists/footnotes)
- [ ] R8 — Nix flake packaging + purge legacy egui


See [`deferred.md`](deferred.md) for the full register of deferred work.
