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
- **Transform drags write once.** The box applies a live matrix to a preview of
  the outline and commits on release, rather than rewriting the outline on every
  move. That keeps one undo step per drag and one save per drag.
- **Components only take similarities.** A component stores dx, dy, a uniform
  scale and a rotation. Skews, flips and stretches are not representable, so they
  skip components and say so; expanding the component first makes it editable.
- **Rotate ring is outside the box only**, so a click inside near a corner is a
  move, not a rotation. Found by mutation testing the hit rule.
- **A stale pen draft crashed the pen** (`n.kind` of undefined): undo removed the
  drafted element but `editor.draft` still pointed at it. The draft is now dropped
  on undo, redo, commit and reload, validated on each pen click, and `isContour`
  accepts a missing element. A random 160-step edit probe (118) guards the family.
- **Handles follow selection.** Drawing every handle always made short handles
  steal node clicks and filled the canvas. Only selected nodes (and the facing
  handle of each neighbour) show handles, and only visible handles can be grabbed;
  Shift+H restores the old show-everything view.
- **Segment drag uses the minimum-norm move**, not a fixed-handle-length drag, so
  the curve point follows the pointer exactly and the handles change as little as
  possible. t is clamped to 0.1..0.9 so a drag near an end cannot throw a handle
  far away. Mutation tests showed that two plausible mistakes (swapping B1 and B2,
  forgetting to rescale the split parameter for a second extremum) are only caught
  by checking the shape, not by counting nodes.
- **Teal in, magenta out for handles.** Colours are picked and checked by
  computed contrast on the dark background, not by eye, because the screenshot
  tool cannot judge them; they also differ from each other, so the two sides can
  be told apart without relying on position.
- **Guide labels live at the left edge of the view**, not at a fixed glyph
  position, so panning and zooming never hide them.
- **Rulers and ruler-dragged guides are deferred** (the viewport model was already
  large); see `deferred.md`.
- **Grid cells share one scale.** Fitting each glyph to its own box would make a
  full stop look as large as a capital and hide spacing. Every cell shows the em
  (and the whole advance if wider), centred on the advance box.
- **Progress counts uncovered sounds as to-do.** "42 of 61 glyphs drawn" means
  glyphs with ink out of glyphs plus sounds that still have none, so it reaches
  100% only when every sound has an actual drawing.
- **The writing view reloads its config on revision bumps.** It used to read
  `config/writing` once at mount, so a change from outside (or a second panel)
  never appeared until the tab was reopened. A reload is skipped while a local
  edit is waiting to save, so it can never clobber typing.
- **Probes seed the app through its own IPC**, not by editing files under the
  workspace: the running app holds the config in memory and would ignore, then
  overwrite, a file written behind its back.
- **Open contours count as filled when hit-testing**, matching how the canvas
  draws them and how the font fills them.
- **The editor effect loop (found after stage 1a).** The canvas resize effect
  called `setCanvasSize`, which read `editor.canvasSize` (to spot the first
  call) and then wrote a new object to it. Read inside the effect, that made
  the effect depend on what it wrote, so it re-ran about 17,000 times a second
  until Svelte threw `effect_update_depth_exceeded`; the app crawled while the
  tab was open. Measured: 53,053 runs and 52,101 `setCanvasSize` calls in 3 s,
  one `fitGlyph`. The probes missed it because they never read the status bar.
  Fix: the setter runs untracked, rounds the measured size to whole pixels,
  ignores changes under a pixel and writes nothing when the size is unchanged;
  the guide setters compare before they assign. With that, an idle editor has
  no frame gap over 50 ms (worst 6 ms) and a pointer move takes 7 ms to paint.
  Not changed: outline stays deep `$state` and pointer moves are not batched,
  because a drag costs under 1 ms per move; change them only if a measurement
  says so. Rule: see standards.md.
- **Probe 22 is intermittently flaky** (translator clause canvas), on builds
  before and after this pass; it is unrelated to the writing system.

## Deferred, not abandoned

Block links, setext-heading resolution, remotes/push, sentence-level grids,
agreement/allomorphy, the tab overflow menu, and the scripting engine are in
`deferred.md` (and `docs/SCRIPTING.md` is design-only).
