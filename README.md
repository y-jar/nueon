<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/branding/nueon-logo-bright.png">
    <img src="assets/branding/nueon-logo-dark.png" width="128" alt="nueon">
  </picture>
</p>

# nueon

A conlang editor and creation app for Linux: a Markdown notebook, a
dictionary/word-table editor, an etymology graph, and a translation builder,
backed by a UI-agnostic Rust core and an optional git history.

Repository: <https://github.com/y-jar/nueon>

## Features

- **Workspaces** — a plain folder holding notes, dictionary tables, assets and
  config; create, open, switch, rename or remove them, with an onboarding
  wizard when none is open. Rediscovery-safe: if a workspace folder is gone,
  it is pruned and the wizard reopens rather than being silently recreated.
- **Markdown notes** — a CodeMirror 6 editor with live preview, KaTeX, task
  lists, tables, images and a formatting toolbar; `.md` by default; notes
  autosave with dirty tracking and on-disk conflict detection.
- **Dictionary grid** — one table per bin of words, per-table tags (Text,
  List, Relation, Checkbox), a pinned `wordname` and `definition` column,
  pills for lists/relations, a ghost row for quick entry, sorting, search,
  column resize/reorder/hide, and a right-click column menu (sort, change
  type, delete tag) where schema edits commit as revertible steps.
- **Inspector & etymology** — edit a word's fields, attach tags, and manage
  multi-parent etymology links (a cycle-safe DAG).
- **Translation builder** — assemble a clause on a slot canvas, open the
  morphology drawer, and run a translation; words can be looked up in the
  dictionary and unknown ones added from the Inspector.
- **Import wizard** — bring in CSV/TSV with auto-detection of delimiter,
  header and column roles, a read-only preview (row/link/duplicate/NFC
  warnings), `[[wiki link]]` parent resolution, and a revertible commit.
- **Export** — the active table to CSV/TSV (round-trip safe) or a lossless
  JSON backup; notes to PDF or ODT.
- **Assets** — drop an image or text file from the OS into the editor or
  explorer; it is copied into `assets/` under a content hash and linked.
- **Version control** — opt-in git with idle auto check-in, status/diff/log, and
  revertible schema edits.
- **Tabs, splits & windows** — tab groups, drag-to-split, persisted layout, and
  torn-off secondary windows; autofocus on creation prompts; search in the grid
  and the note editor.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the three-tier design.

## Keyboard shortcuts

In a Markdown note (`Mod` is `Ctrl` on Linux; these bindings live only in the
editor, so they never fire in the dictionary grid, inputs or the inspector):

- `Mod+B` / `Mod+I` / `Mod+U` — bold / italic / underline
- `Mod+K` — link
- `Mod+Shift+7` / `Mod+Shift+8` / `Mod+Shift+9` — numbered / bullet / quote
- `Mod+Shift+C` — code block; `Mod+Shift+X` — strikethrough
- `Mod+1` … `Mod+6` — heading level (the same level again removes it);
  `Mod+0` — normal text
- `Tab` / `Shift+Tab` — next / previous table cell; `Enter` — new table row
- `(` `[` `{` — auto-close the bracket (`'` and `"` are left alone)
- `Mod+Z` / `Mod+Y` — undo / redo; `Mod+W` — close tab
- `Ctrl`/`Cmd`+click — add a cursor; `Alt`+drag — rectangular selection

## Installation

### Nix (recommended)

```sh
# Build the app from source (Rust + Svelte + WebKit/GTK, fully pinned):
nix build .#
./result/bin/nueon

# Or run it directly:
nix run .#
```

A precompiled variant (`nueon-bin`) fetches a published release `.deb`, patches
it for Nix, and wraps it with the same Wayland-safe WebKit flags:

```sh
nix build .#nueon-bin
./result/bin/nueon
```

`nueon-bin` has a placeholder hash until a release exists; after publishing,
refresh it with
`nix-prefetch-url --type sha256 https://github.com/y-jar/nueon/releases/download/v<version>/nueon_<version>_amd64.deb`.

### Linux packages

`.deb`, `.rpm` and `.AppImage` bundles are published on the
[Releases](https://github.com/y-jar/nueon/releases) page for each `v*` tag.
Install the `.deb`/`.rpm` with your package manager, or mark the AppImage
executable and run it.

### From source

Everything needed (Rust, Node 22, Tauri's WebKit/GTK libraries) is provided by
the Nix dev shell:

```sh
nix-shell
npm install
npm run tauri dev      # hot-reloading dev app
npm run tauri build    # produces bundles under src-tauri/target/release/bundle
```

## Verification

See [`docs/PROBING.md`](docs/PROBING.md) for the full testing/probing
methodology (unit tests, the WebDriver probe harness, and the traps to avoid).

Run the full gate suite from the Nix shell (`gates` runs exactly these; CI
mirrors them after `npm ci`):

```sh
npm run build
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run check          # svelte-check
npm run test           # node:test unit tests
sh scripts/check-icons.sh
sh scripts/test-version.sh
sh scripts/check-version.sh
```

After packaging changes, also verify the app bundles with `nix build .#` (CI
and `gates` do not run it).

## Development

The dev shell provides short aliases and matching `loom-*` commands
(`deps dev run app pkg fmt fmtcheck clippy ctest testall fecheck febuild
icons iconcheck bump versioncheck clean gates`); run `aliases` in the shell to
list them. `run` builds the Nix package and launches it; `dev` starts the
hot-reload server.

## Versioning

Versions are date-based: `YY.M.D` with no zero padding, for example `26.10.6`.
The version is the release date and it always increases. Cargo, npm and Tauri
require three numeric parts, so a “major update” name like `26.8` is written
`26.8.0` wherever a tool needs three parts; the major label is only a name in
the release notes, never a different version.

Release flow:

```sh
scripts/bump-version.sh     # today's date; or pass YY.M.D explicitly
gates                       # all checks, including scripts/check-version.sh
git commit -am "RELEASE: 26.10.6"
git tag v26.10.6
# publishing (git push, pushing the tag) is a manual, explicit step
```

`scripts/bump-version.sh` writes one version to `Cargo.toml`
(`[workspace.package]`), `Cargo.lock`, `package.json`, `package-lock.json`,
`src-tauri/tauri.conf.json` and every `version = "…"` in `flake.nix`.
`scripts/check-version.sh` fails on any mismatch, a zero-padded or malformed
date, a tag that is not `v` + the version, or a version that goes backwards
(compared numerically per part, so `26.10.6 > 26.8.19`). It runs in CI and in
`gates` (no tag), and in `release.yml` with the pushed tag.

Until the first release the version is the `0.1.0` placeholder. It is accepted
only when no tag argument is given and no `v*` tag exists yet, and it must
still be identical in every file above; cutting the first date release retires
it (a later `v*` tag also makes `0.1.0` invalid).

**File and workspace formats are versioned separately from the app version.**
The date version tracks the application; the on-disk layout of notes, tables,
assets and the workspace config is not tied to it and changes only when a
migration says so (see `docs/ARCHITECTURE.md` and `deferred.md`).
