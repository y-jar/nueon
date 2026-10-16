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
- **The preview shapes in Rust, against the font the export writes.** A second
  planner in TypeScript would drift from the font the first time a rule or a
  positional form changed. harfrust (MIT, a HarfBuzz port) is now a runtime
  dependency rather than dev-only; NOTICE says so, and `Cargo.lock` already held
  it, so the nix vendor hash did not change. The cost is one compile when the font
  changes, avoided while typing by a one-slot cache keyed on a hash of everything
  the font depends on. Rejected: a browser `@font-face` (no per-glyph positions,
  so no advance boxes or gap dragging) and a hand-written shaper.
- **The preview is more forgiving than the export.** A rule naming a missing glyph
  blocks an export but is skipped in the preview, so a half-built system still
  previews.
- **Preview spacing edits reuse the grid's undo log.** Dragging a gap changes two
  glyphs; the grid log already records one step across many glyphs, so the same
  undo reverses it.
- **The back layer's images live in `writing/assets/`, not `notes/assets/`.** The
  existing asset importer is reused (it is base-dir agnostic), but a
  writing-scoped dir keeps the two worlds apart: sweeping an unreferenced asset
  when a glyph is deleted can never break a note that embeds the same file in
  Markdown, and a note attachment is never mistaken for tracing material. The
  glyph file stores only the imported, sanitized file name — never a path — plus
  a font-unit centre and width; the height follows the file's aspect ratio at
  draw time, so the stored data never depends on pixel size.
- **Formats are sniffed from magic bytes, and SVG is deferred.** png, jpg and
  webp are accepted by content (a `.png`-named text file is rejected); SVG would
  need sanitising before it enters a webview, so it is left out until that
  exists.
- **The 10 MB limit warns rather than refuses.** The import command rejects
  files above it unless `force`; the UI asks first with the shared confirm
  dialog, so an accidental 40 MB scan is a question, not a dead end, and the
  guard is probe-testable without a native dialog.
- **Clearing an image keeps the asset file; deleting the glyph sweeps it.** A
  clear is just an outline edit, so undo must restore the image — that requires
  the file to still exist. The sweep runs when glyph metas vanish from the
  writing config (the app's own delete path), deleting the outline file and any
  asset no remaining outline references; identical imports shared the file, so
  the last reference decides.
- **Editor-only material never touches the font.** The font key and the compiled
  font read only glyphs' metadata, contours and advances, so a tracing image
  cannot invalidate the preview cache or change an export — both are tested
  byte-for-byte.
- **The Knife cuts at the exact clicked point; the Eraser keeps its boundary
  cut.** Two cutters would be one too many, but they answer different gestures:
  the Eraser deletes nodes and cuts at node boundaries, the Knife only cuts,
  exactly where you click (exact de Casteljau subdivision, so the shape is
  untouched), which is what tracing into pieces actually wants.
- **The Measure tool is a view tool, not an edit tool.** It changes nothing, so
  it stays available with the fore layer hidden (Hand and Zoom are its company),
  and it borrows the info bar's existing distance-and-angle readout instead of a
  new one.
- **A freehand stroke that ends where it began closes, and nodes are placed by
  the stroke's order.** A hand-drawn circle is the common freehand shape, so
  the fit detects closure (enough points, real extent, ends within an
  allowance of 4% of it) and fits it cyclically: tangents wrap, the path
  closes, and the two stroke-ends are one node. The first version placed added
  nodes by projecting them onto the chords already drawn — on a wobbly circle
  the chords zigzag and the projection scrambled the node order into a
  12-node spaghetti pile (measured 87 units off). The stroke's point order was
  available all along; the fit now inserts by index and a winding test holds
  it honest.
- **Guides are session aids, not data.** Rulers and the guides dragged out of
  them change no file and carry no undo history; a guide is a view-layer line
  like a metric rail (it hides with the guide layer), deletable by dropping it
  back on its ruler. Persisting guides per glyph would need a format change;
  deferred until the session-only version proves worth keeping.
- **Guides join the snap claims; the ink keeps first claim on the pointer.**
  A dragged guide grabs at 6 px, but only after contours, nodes and handles
  have declined the click — the drawing is what you edit; the guide is what
  you align with. Custom guides feed the same snap claim list as the metric
  rails (`guide 750` labels), with the existing nearest-wins priority.
- **The Freehand fit is worst-point refinement, not a curve-fitting library.**
  Catmull-Rom handles on the ends, then add the drawn point the path misses most
  until within 2 units or 12 nodes. An RDP pre-pass was dropped after mutation
  testing showed the refinement loop reproduces it for every tested stroke.
  Accepted as unobservable: which of two equally-missed points the pick takes
  first (a tie has no effect on the result).
- **A hidden Fore layer blocks editing, not viewing.** Editing invisible
  outlines would be blind luck, so every tool except the view tools waits; the
  back image stays reachable so a scan can be inspected alone.
- **HTML blocks render through an allowlist sanitiser, never raw.** A note's
  HTML block is arbitrary user content that used to go straight into
  `innerHTML` with the app's CSP unset, so any note could run script.
  DOMPurify (Apache-2.0 OR MPL-2.0; used under Apache-2.0) now sanitises with
  an explicit tag/attribute allowlist and a URI regexp that drops `javascript:`
  URLs; handlers, scripts, frames and forms never reach the DOM, benign
  markup survives, and a hostile note (`<img onerror=…>`, `<script>`,
  `<iframe>`, `<form>`, `javascript:` link) is covered by a probe that fails
  the moment anything runs.
- **A boolean's result is every piece, with holes wound against their
  outline.** `flo_curves`' `path_combine` returns one subpath per piece, and
  the first version kept only the first: a union of disjoint shapes silently
  lost all but one piece on a Difference or Exclude (a dot beside a body
  vanished; measured, not guessed). Every subpath is now passed through, and
  subpaths nested inside another (holes, notches) are reversed so the nonzero
  rule the canvas and the compiled font both use cuts them out — `flo_curves`
  returns every subpath wound the same way, which filled holes solid.
- **Bearings follow FontForge.** The left bearing moves the ink and the advance
  together; the right bearing and the advance change only the advance. Only the
  advance is stored: the left bearing is the ink's left edge and the right bearing
  is derived, so there is one source of truth and the font cannot disagree with
  the editor. The unused `lsb`/`rsb` fields on the outline file are left in the
  format for compatibility but are no longer written or read.
- **The bearing boxes did nothing before this stage.** They stored a value the
  compiler ignored, so typing in them changed neither the glyph nor the font. A
  control that does nothing is worse than none; they now edit the real values, and
  a probe compares what the box shows with the numbers in the stored outline.
- **Grid spacing edits have their own undo log.** The editor's history is per open
  glyph, but a grid edit can touch many glyphs (a batch). A small log of
  before/after outlines per change gives one undo step per change.
- **A node on a bearing line keeps priority** over the line, so an edge node moves
  as a node. Found when a probe drew a block whose left nodes lie exactly on the
  left-bearing line.
- **Shift means "aim for snapping", not "no snapping".** It used to switch
  snapping off. Users reach for Shift when they want help, so it now adds
  alignment with other nodes and 45/135 degree lines, and guide-line feedback.
  Rejected: a separate key; one more modifier to remember.
- **A node lock beats every alignment**, and guide rails, the left edge and the
  advance keep their axis, so Shift can only add precision, never move a point off
  something it already snapped to. Found by mutation testing; three of the ten
  claims in `snapExtended` were untested until then.
- **Line hit-testing is exact, not sampled.** `nearestSegment` took the closest
  of 24 samples, which on a long line left gaps wider than the click radius: a
  click right on a 1200 unit line missed 43% of the time (measured), so Node Mod
  felt random. It now refines to the true closest point (0% missed).
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
