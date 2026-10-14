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

## Packaging

- **Two Nix packages**: `default` (build from source) and `nueon-bin` (fetch the
  published release `.deb`, `autoPatchelf` + `wrapGAppsHook3` it). `nueon-bin` is
  the fast path; `default` is the dev/fallback path. Each release refreshes the
  `.deb` hash in `flake.nix` (see `docs/RELEASING.md`).
- **nixpkgs is pinned to a stable release** (`nixos-26.05`), not the floating
  `"nixpkgs"` registry ref. The floating ref once resolved to an unstable rev
  mid-glibc-bump and produced a mixed glibc-2.42/2.44 closure that broke the app
  at runtime. The frontend also pins `nodejs_22` to match the dev shell and CI.
- **Release builds run on Ubuntu 22.04 in CI** (single runner) for the widest
  glibc baseline and no asset-name collision; the AppImage bundler needs an FHS
  (`/bin/bash`) that NixOS doesn't provide, so it is built in CI, not locally.

## Data

- **Plain extensionless JSON files** for tables and config, `.md` for notes. A
  workspace is just a folder; portable, versionable, diff-able.
- **A hidden UUID per word entry**, independent of the `wordname`, so homographs
  stay distinct and renames/re-imports keep identity.
- **Dynamic schema**: only `wordname` is required; every other field is a
  user-defined tag with a type. Tags are scoped to their table.

## Robustness

- **Config files load leniently.** A missing or unparseable `config/<name>`
  falls back to its default and is reported in the quarantine banner instead of
  refusing to open the workspace. Version skew (an old build reading a newer
  config) or a hand-edit typo must never lock the user out of their notes and
  dictionary — the same guarantee dictionary files already get.

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

## Writing-system editor polish pass

- **Viewport is a model, not a CSS trick.** `{ cx, cy, scale }` plus the
  measured canvas size, with pure screen/glyph transforms. Zoom about the
  cursor, pan and zoom-to-rectangle are unit-tested; the SVG `viewBox` is
  derived. Rejected: scrolling an oversized SVG, which cannot zoom about a
  point and gave no way to test pan.
- **Ctrl stays the constraint key.** An earlier draft made Ctrl+Pen switch to
  Select. Ctrl already constrains pen segments and handle drags to 15 degrees
  and drags to an axis, so the temporary-Select idea was dropped. Select is one
  key away (V).
- **Two selections, one active.** Whole elements (`editor.elements`) and nodes
  (`editor.selection`) are separate lists; tools write one and clear the
  other. Rejected: a single mixed list, which makes "delete" ambiguous.
- **Open contours count as filled when hit-testing**, matching how the canvas
  draws them and how the font fills them.
- **Probe 22 is intermittently flaky** (translator clause canvas), on builds
  before and after this pass; it is unrelated to the writing system.

## Deferred, not abandoned

Block links, setext-heading resolution, remotes/push, sentence-level grids,
agreement/allomorphy, the tab overflow menu, and the scripting engine are in
`deferred.md` (and `docs/SCRIPTING.md` is design-only).
