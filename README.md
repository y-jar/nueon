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

## Development

Everything is provided by the Nix shell:

```sh
nix-shell
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

Run against a workspace directory (defaults to `$XDG_DATA_HOME/langjar` or
`~/.local/share/langjar`):

```sh
cargo run -- /path/to/workspace
```

## Roadmap

- [x] Tables + per-table tags, sparse storage, config, git backend
- [ ] egui/eframe three-pane app shell + git side panel
- [ ] Live-preview Markdown editor
- [ ] Dictionary grid, etymology/derivation engine
- [ ] Drag-and-drop translation builder
- [ ] Nix flake for packaging
