# langjar

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
- **Left sidebar** — notes, tables, and translation presets; create tables.
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

Keyboard: `Ctrl+K` search, `Ctrl+S` save note, `Ctrl+E` raw/rendered toggle,
`Ctrl+T` translation, `Ctrl+Shift+G` toggle Source Control.

## Development

Everything is provided by the Nix shell:

```sh
nix-shell
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

Run the app against a workspace directory (defaults to `$XDG_DATA_HOME/langjar`
or `~/.local/share/langjar`):

```sh
cargo run -- /path/to/workspace
```

Headless CI/load check (prints workspace summary, no window):

```sh
cargo run -- --check /path/to/workspace
```

## Roadmap

- [x] Tables + per-table tags, sparse storage, config, git backend
- [x] egui/eframe three-pane shell, docked tabs, dictionary grid, git panel
- [x] Block live-preview Markdown notes editor (click-to-reveal, autosave)
- [x] Etymology/derivation: multi-parent DAG, parent picker, dependency warnings
- [x] Dictionary grid column sort / filter / per-column search / visibility
- [ ] Drag-and-drop translation builder
- [ ] Dictionary word highlighting / hover previews in the notes editor
- [ ] Nix flake for packaging

See [`deferred.md`](deferred.md) for the full register of deferred work.
