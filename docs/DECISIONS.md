# Decisions & rationale

The choices that are expensive to reverse or easy to forget, and why.

## Stack

- **Tauri + WebKitGTK** (not Electron). Smaller footprint, native Linux feel,
  Wayland support via WebKit flags. Consequence: we live with WebKitGTK quirks
  (below).
- **Rust core (`nueon-core`) with no I/O beyond files and the `git` CLI.** The
  model/storage/engine is unit-testable without a UI; the frontend only speaks
  to it over IPC.
- **Svelte 5 (runes)** for the frontend, with a single reactive `ui` store rather
  than many stores. See `STATE.md`.

## Data

- **Plain extensionless JSON files** for tables and config, `.md` for notes. A
  workspace is just a folder; portable, versionable, diff-able.
- **A hidden UUID per word entry**, independent of the `wordname`, so homographs
  stay distinct and renames/re-imports keep identity.
- **Dynamic schema**: only `wordname` is required; every other field is a
  user-defined tag with a type. Tags are scoped to their table.

## Git

- **The system `git` CLI, never a library.** We shell out for status/log/diff/
  commit/checkout. Idle auto check-in is opt-in per workspace.

## Translation & morphology

- **Clause-level translation**, not sentence-level. A drag-and-drop grid of slots
  describes word order; the engine maps an English sentence onto it.
- **Fixes tables** supply morphemes (surfaces like `-i`) and are distinguished
  from vocab tables by `table_roles` in `config/translation`; the link dropdown
  ranks Fixes words below vocab.

## WebKitGTK quirks (learned the hard way)

- `Ctrl+Shift+Tab` arrives as key `"Unidentified"`, so the backward tab-cycle
  binding is `Ctrl+PageUp`, not `Ctrl+Shift+Tab`.
- The `::-webkit-scrollbar` and `scrollbar-width: none` pair is how we hide the
  tab-strip scrollbar while keeping it scrollable.
- `color-mix()` resolves to `color(srgb …)` in `getComputedStyle`; the contrast
  probe parses that form.
- The WebDriver probes run under Xvfb with the Wayland `WEBKIT_DISABLE_*` flags
  **unset** (`writeWrapper` in `probes/probe.mjs`); the real desktop sets them.

## The "one commit per stage, probe first" contract

Every behaviour change ships as: a failing probe/test that reproduces the
problem, the fix, then `loom-gates` + `nix build .#` + the full probe suite, one
commit per stage. See `docs/PROBING.md`.

## Deferred, not abandoned

Block links, setext-heading resolution, remotes/push, sentence-level grids,
agreement/allomorphy, the tab overflow menu, and the scripting engine are in
`deferred.md` (and `docs/SCRIPTING.md` is design-only).
