# Writing System: design proposal

This document is a design proposal for the writing-system module: a tool for
drawing glyph vectors, mapping them to the language's phonemes, previewing words
in the script, and exporting a font plus a JSON profile. Nothing here is
implemented and nothing here changes code. The goal is to lay out the choices,
each with a recommendation and reasons, so they can be reviewed before any code
is written.

Status: proposal, not a decision.

## Naming

The feature is the **writing system** everywhere: config name `writing`, tab
kind `writing`, Rust module `writing_system`, UI label "Writing System". It is
never called "script", because `docs/SCRIPTING.md` is the (separate) user
scripting engine proposal and the two must not be confused. This includes the
exported font format: "script" refers to a Unicode script, not this feature.

## Purpose

A conlang needs a way to write itself down. The writing system turns the
phonology (an IPA inventory) and the dictionary (words) into a concrete
orthography: glyphs with real outlines, mapped to sounds, composed into word
strings through ordered rules, previewable in the translator, and exportable as
a usable font. It is the missing link between the phonology tab (sounds) and the
translation tab (word strings).

## The twelve decisions

### 1. Storage: per-glyph files plus an index

- **Recommendation.** A `writing/` directory with one JSON file per glyph
  (`writing/glyphs/<id>.json`) holding the outline and metrics, and a small
  index (`config/writing`) holding everything else — glyph identity, order,
  phoneme mapping, orthography rules, font settings, direction.
- **Why two files.** Glyph outlines are the large, volatile data (hundreds of
  coordinates per glyph). Splitting them out keeps git diffs readable and
  atomic writes small: editing one glyph rewrites one file, not the whole
  system. The index is small and changes rarely; it lives in `config/` so it
  flows through the existing `config_get`/`config_set`/profile machinery.
- **Stable ids, never names.** Each glyph has a hidden UUID, independent of its
  display name and its mapped phoneme symbol, exactly like dictionary words
  (`docs/DECISIONS.md`). The index keys glyphs by id; the outline file is named
  by id.
- **Trash, rename, delete.** Delete moves the glyph's outline file to the
  existing trash and removes it from the index; restore puts both back. Rename
  changes only the display name (the id and file are untouched). Deleting a
  glyph that rules or words depend on flags those dependents as broken rather
  than silently dropping them (see decision 12).

### 2. Coordinates: font units, y-up, derived bearings

- **Recommendation.** Font units with a units-per-em of **1000**. Storage is
  y-up (positive is up, the font convention). The editor view flips y for
  display only. Store **advance width** and **left/right side bearings**; derive
  the side bearings from the outline's bounding box whenever the outline
  changes, but keep them storable so the user can override them (a glyph whose
  ink is intentionally narrower than its spacing, or vice versa).
- **Why.** 1000 upem is the de-facto font default and keeps coordinates small
  integers that survive round-trips to cubic Beziers without float drift. y-up
  storage matches every font format (glyf/CFF) so export needs no transform
  bookkeeping; the SVG view flips it once, near the display boundary.

### 3. Outline model: contours of nodes, cubic Beziers

- **Recommendation.** A glyph is an ordered list of contours. Each contour is a
  list of nodes; each node has an on-curve point `(x, y)` and optional in/out
  handle offsets, a kind (`corner`, `smooth`, `symmetric`), and the contour has
  a `closed` flag and a fill rule (`nonzero` / `evenodd`). Segments between
  nodes are **cubic Beziers** in storage. On export, winding is normalised (the
  outermost contour counter-clockwise or clockwise by convention, inner contours
  opposite) so renderers treat them as holes correctly; pathfinder operations
  always re-run this normalisation because they can reverse winding.
- **Why cubic.** CFF/OpenType and most editors are cubic-native; TrueType's
  quadratic glyf is produced at export time by a cubic-to-quadratic conversion,
  so storing cubic loses nothing and avoids committing to one output flavour.

### 4. Writing direction and positional forms

- **Recommendation.** A writing-system-level direction of `ltr`, `rtl`, or
  `ttb`. Positional forms (isolated/initial/medial/final for joining scripts)
  are **deferred past v1** and only designed (see stage 8).
- **Why defer.** Direction is one field and cheap; positional forms require
  contextual substitution rules, a per-glyph form set, and joining behaviour in
  the preview — a large surface that only some scripts need. Shipping
  direction-only first keeps v1 useful for the common case.

### 5. Codepoint plan: PUA allocation + GSUB romanisation

- **Recommendation.** Automatic Private Use Area (U+E000–U+F8FF) allocation,
  stable once assigned, user-overridable, with collision checks against both the
  Unicode PUA already in use and the language's other glyphs. Separately, the
  exported font maps the **Latin romanisation to glyphs** through OpenType
  `GSUB` substitution rules (ligature- and context-features compiled with
  `fea-rs`), so typing the romanisation in any app renders the script without a
  custom keyboard.
- **Why.** PUA is the only portable place for invented glyphs that survive font
  install. The romanisation→glyph GSUB is what makes the exported font actually
  *usable* — otherwise users would have to type untypeable PUA code points.

### 6. Mapping and rules: glyph ↔ phoneme, many-to-many, ligatures

- **Recommendation.** A glyph maps to zero or more phoneme ids (many-to-one and
  one-to-many are both allowed — one glyph can cover an affricate, several
  glyphs can all render one sound). Ligatures are rules, not mappings. A word
  string from the lexicon evaluates **left to right** through ordered
  orthography rules to a glyph sequence; the result is what the preview and the
  font substitution features render.
- **Why.** Phoneme↔glyph is not 1:1 in real scripts, so the mapping must be
  many-to-many. Keeping ligatures in the rule engine (not a per-glyph flag)
  means one mechanism handles "two sounds → one glyph" and "one sound → two
  glyphs" uniformly.

### 7. Canvas technology: SVG + a pure-TS geometry layer

- **Recommendation.** Render the editor with **SVG** and pointer events, backed
  by a **pure TypeScript geometry and command layer** (no DOM, testable with
  `node --test`), with Svelte 5 `$state.raw` for the outline data and an
  undo/redo stack that is **separate from the app's git history**.
- **Argument for SVG over Canvas2D/WebGL.** A vector editor is fundamentally a
  scene graph of a few thousand nodes, hit-testable and re-stylable natively;
  SVG gives us `<use>`-based glyph preview for free (decision 8), accessible
  element outlines, and DOM event delegation, at effectively no cost at this
  scale. Canvas2D/WebGL would only pay off for pixel-heavy raster effects (the
  calligraphic brush is a stroke-then-outline operation, not a per-pixel one),
  and they would force us to reimplement hit-testing, selection, and preview.
  `$state.raw` avoids Svelte proxying thousands of coordinate objects on every
  drag tick.
- **Why a separate undo stack.** The app's git history is for whole-workspace
  check-ins, not per-drag gestures. A dedicated command stack (each tool action
  one invertible command) gives instant, cheap undo in the editor without
  touching VCS.

### 8. In-app preview: `<use>` of glyph symbols, plus FontFace

- **Recommendation.** Render preview glyph sequences directly from outlines as
  SVG, one `<symbol>` per glyph referenced with `<use>`, so preview needs no
  font install and reflects the live outlines. Separately, load the compiled
  font through `FontFace` in a verification step to confirm the *real* export
  (cmap, GSUB, hinting-free raster) renders correctly.
- **Why.** Previewing the live outlines avoids a compile step on every edit; the
  FontFace check catches bugs that only appear in the produced font (wrong
  codepoints, broken substitution, missing metrics) that raw-outline preview
  cannot.

### 9. Where work runs: TS for editing, Rust for heavy ops

- **Recommendation.** Interactive editing (tools, selection, transforms, the
  undo stack) runs in TypeScript. Boolean operations, font compilation, and
  validation run in Rust commands (`nueon-core`). **No IPC on pointer move** —
  the pointer path stays local and only commits a glyph through one IPC call
  when an editing gesture finishes.
- **Why.** Editing is latency-sensitive and interaction-shaped; geometry
  booleans and font writing are CPU-heavy, deterministic, and unit-testable
  without a UI. Keeping them in the Rust core matches the existing split (see
  `docs/ARCHITECTURE.md`) and the "no I/O beyond files + git" rule.

### 10. Pathfinder and font crates

Verified against crates.io (licence, activity, current version) at design time;
exact MSRVs are re-confirmed during the prototype spike since most crates
publish no `rust_version` field. Our toolchain is **Rust 1.95**.

| crate | licence | role | notes |
|---|---|---|---|
| `kurbo` | MIT/Apache-2.0 | curve maths | cubic/quadratic Beziers, affine transforms, `cubics_to_quadratics`. No boolean ops. Actively maintained (Linebender). |
| `write-fonts` | Apache-2.0 | font writing | writes `glyf`, `cmap`, `hmtx`, `GSUB`, `GPOS`, etc. Actively maintained (fontations). |
| `fea-rs` | Apache-2.0/MIT | feature compile | compiles Adobe feature text to GSUB/GPOS binary. Maintained in the fontations ecosystem. |
| `read-fonts` / `skrifa` | Apache-2.0 | read-back validation | `read-fonts` parses/validates tables; `skrifa` wraps it for metrics/scaling. |
| `flo_curves` | Apache-2.0 | booleans (curve-preserving) | `path_intersection`/`path_combine` operate on cubic Beziers, not polygons. v0.8.1, actively maintained. |
| `i_overlay` | MIT | booleans (polygon) | flattens Beziers to polylines before boolean ops. |

- **Booleans must keep curves.** `flo_curves` is the recommended boolean
  engine because it preserves cubic Beziers through the operation; `i_overlay`
  flattens to polygons, which would irreversibly degrade every curve on the
  first pathfinder use. The trade-off is that curve-preserving booleans are
  numerically harder (the riskiest piece of the whole feature).
- **TrueType vs CFF.** Both are practical. The stored model is cubic; `kurbo`'s
  `cubics_to_quadratics` covers the TrueType `glyf` path, while CFF output
  keeps cubics natively. Recommend **TTF (quadratic `glyf`) as the default**
  (broadest compatibility, simplest validation) and CFF/OTF as a later option.
- **Prototype spike (stage 6, before committing to it).** The riskiest crate is
  `flo_curves` booleans on degenerate contours (self-intersection, near-zero
  area, coincident nodes). The spike is: feed two overlapping cubic contours
  through union/intersect and read the result back with `read-fonts`-style
  validation, checking winding and that no segment became a polygon. If it does
  not hold up, the fallback is `i_overlay` with a pre-flatten tolerance and a
  documented fidelity loss.
- **New dependencies require** `Cargo.lock`, `flake.nix` and `NOTICE` updates
  per `docs/MAINTENANCE.md`.

### 11. Keyboard layouts: out of scope

- **Recommendation.** OS-level keyboard files (XKB, Windows `.klc`, macOS
  `.keylayout`) are out of scope for v1; the JSON profile may carry the mapping
  data (romanisation → glyph) but ships no system keyboard.
- **Why.** System keyboards are per-platform, install into privileged
  directories, and are unnecessary once the font carries the romanisation
  through GSUB (decision 5) — typing the romanisation *is* typing the script.
  The profile's mapping data is the source of truth that later keyboard
  exporters (if ever) would consume.

### 12. Reassign/delete/rename a depended-on glyph

- **Recommendation.** When a glyph is reassigned, deleted, or renamed while a
  rule or a word's preview depends on it, **flag the dependent as broken and
  never silently drop it**. Deletion warns with the list of dependents; a
  rule whose glyph no longer exists is shown as broken in the editor rather than
  skipped. A preview that references a missing glyph renders a visible
  placeholder (not the glyph silently vanishing).
- **Why.** This is the same bug class as name-keyed table state and
  symbol-keyed phoneme mapping: silent drops orphan data and make rules
  irreproducible. Keeping the reference and marking it broken is honest and
  reversible.

## Type sketches

### Rust (`crates/nueon-core/src/config/writing_system.rs`)

```rust
//! Writing system: glyph outlines, phoneme mapping, orthography rules.

use serde::{Deserialize, Serialize};

/// Writing direction at the writing-system level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WritingDirection { Ltr, Rtl, Ttb }

/// Node kinds: corner has free handles, smooth has colinear handles, symmetric
/// has equal-length colinear handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind { Corner, Smooth, Symmetric }

/// Fill rule for a contour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillRule { Nonzero, Evenodd }

/// One on-curve point with optional Bezier handles (offsets from the point).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle_in: Option<(f64, f64)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle_out: Option<(f64, f64)>,
    pub kind: NodeKind,
}

/// One closed or open path of nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Contour {
    pub nodes: Vec<Node>,
    pub closed: bool,
    pub fill_rule: FillRule,
}

/// A glyph's vector data, stored one-per-file in `writing/glyphs/<id>.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GlyphOutline {
    pub contours: Vec<Contour>,
    /// Explicit advance width in font units; None derives from bounds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advance: Option<f64>,
    /// Explicit side bearings; None derives from bounds when placed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lsb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rsb: Option<f64>,
}

/// One glyph's identity and mapping, held in `config/writing`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlyphMeta {
    /// Stable id; the outline file is `writing/glyphs/<id>.json`.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Allocated codepoint (PUA), user-overridable.
    pub codepoint: u32,
    /// Phoneme ids this glyph renders (many-to-many).
    #[serde(default)]
    pub phonemes: Vec<String>,
    /// Display order in the glyph grid.
    #[serde(default)]
    pub order: u32,
}

/// An ordered orthography rule: a grapheme/phoneme sequence becomes a glyph
/// sequence in a context. Reuses the phonology tokenizer and context matcher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrthographyRule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The grapheme/phoneme sequence to match.
    pub from: String,
    /// Glyph ids to emit.
    pub to: Vec<String>,
    /// Context constraints, using the phonology `C V L #` vocabulary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<String>,
}

/// The writing-system config file (`config/writing`), and the part of Profile
/// v3 that travels with it. Outlines are referenced by id, never embedded.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WritingConfig {
    pub direction: WritingDirection,
    /// Units per em, fixed at 1000.
    pub upem: u16,
    /// Metrics guide heights (baseline is 0 by convention).
    pub x_height: f64,
    pub cap_height: f64,
    pub ascender: f64,
    pub descender: f64,
    /// Ordered glyphs.
    pub glyphs: Vec<GlyphMeta>,
    /// Ordered orthography rules, applied left to right.
    pub rules: Vec<OrthographyRule>,
    /// OpenType feature text (GSUB romanisation → glyphs).
    pub features: String,
}
```

`Phoneme` gains a stable id (decision in the phoneme-id note below):

```rust
pub struct Phoneme {
    /// NEW stable UUID, backfilled on load when absent.
    #[serde(default)]
    pub id: String,
    pub symbol: String,
    pub kind: PhonemeKind,
}
```

### TypeScript (`src/lib/writing.ts`, mirrors the Rust types)

```ts
export type WritingDirection = "ltr" | "rtl" | "ttb";
export type NodeKind = "corner" | "smooth" | "symmetric";
export type FillRule = "nonzero" | "evenodd";

export interface Node {
  x: number;
  y: number;
  handleIn?: [number, number] | null;
  handleOut?: [number, number] | null;
  kind: NodeKind;
}

export interface Contour { nodes: Node[]; closed: boolean; fillRule: FillRule; }

export interface GlyphOutline {
  contours: Contour[];
  advance?: number | null;
  lsb?: number | null;
  rsb?: number | null;
}

export interface GlyphMeta {
  id: string;
  name: string;
  codepoint: number;
  phonemes: string[];
  order: number;
}

export interface OrthographyRule {
  name?: string;
  from: string;
  to: string[];
  left?: string;
  right?: string;
}

export interface WritingConfig {
  direction: WritingDirection;
  upem: number;
  xHeight: number;
  capHeight: number;
  ascender: number;
  descender: number;
  glyphs: GlyphMeta[];
  rules: OrthographyRule[];
  features: string;
}
```

The editor's command/undo model (pure, node-tested) is a small tagged union of
invertible commands — add/remove node, move node, set handle, add/remove
contour, apply pathfinder, set metric — each with an `apply` and an `undo`
against an immutable `GlyphOutline` snapshot. The live editing state is stored
with `$state.raw` and only the finished glyph is persisted.

## File layout on disk

```
<workspace>/
  config/writing            WritingConfig: direction, metrics, glyph index,
                            rules, GSUB feature text (small, diffable).
  writing/glyphs/<id>.json  one GlyphOutline per glyph (large, atomic per-glyph).
```

`writing/` sits beside `notes/`, `dictionary/` and `config/`. The glyph outline
files are the "assets" of the writing system, analogous to images in `notes/`;
they travel with the workspace and the zip export but are **not** embedded in
the JSON profile. `config/writing` is the part that joins `Profile` v3.

### Profile v3

`Profile` becomes version 3, still importing v1 and v2 (the `validate()` bound
moves from 2 to 3, and v1/v2 imports backfill a default `WritingConfig`). The
writing system joins the profile as `profile.writing`, but only its config
(index, rules, settings) — the glyph outlines stay in `writing/glyphs/`. The
profile is "how the language works"; the outlines are data (the same split that
keeps dictionary tables out of the profile today). An option to embed outlines
in a profile is deferred and listed as a question below.

## Component tree

```
WritingSystemView.svelte                (tab body; owns glyph grid + editor route)
├── WritingHeader.svelte                Add / Export, multi-select mode + count
├── SoundListRow.svelte                 "Lists of Sounds" grouped by category
├── GlyphGrid.svelte                    wrapping grid of tiles
│     └── GlyphTile.svelte              preview, left-click open, right-click menu
└── VectorEditor.svelte                 (opened from a glyph tile)
      ├── EditorMenuBar.svelte          File / Edit / View / Tools / Metrics / Glyphs / Export
      ├── EditorToolbar.svelte          tool picker, zoom, snap toggle, export
      ├── Toolbox.svelte                pen/direct-select/nodes/shapes/… + pathfinder
      ├── GlyphCanvas.svelte            zoom/pan/grid-snap/metric guides, tool input
      ├── GlyphMetricsPanel.svelte      name, phoneme, codepoint, LSB/RSB, advance
      ├── GlyphMatrixDrawer.svelte      batch glyph matrix (drawer)
      └── EditorStatusBar.svelte        active glyph, node count, canvas, snap
```

**State ownership.** The `WritingSystemView` owns the `WritingConfig` and the
open glyph id. The `VectorEditor` owns the *editing* state for the open glyph:
the `$state.raw` outline, the selection, the active tool, and the undo/redo
stack. The pure geometry/command layer (`src/lib/writing/`) owns no DOM and no
Svelte state — components call into it and render its results. On a finished
gesture, the editor commits the glyph through one IPC call; there is no IPC on
pointer move.

**Glyph grid.** `GlyphGrid` reads `config.writing.glyphs` (ordered by `order`)
and renders one `GlyphTile` per glyph as a `<symbol>`/`<use>` preview that wraps
in a grid. Left-click opens the glyph in the editor; right-click opens the
`glyph` context-menu kind (Edit, Delete, Reassign Phoneme, plus Duplicate, Set
Metrics, Clear Codepoint — proposed additions). Multi-select toggles a
"count selected" mode in `WritingHeader` with batch actions: Edit selected,
Export selected, Reassign, Delete, Set metrics.

**"Lists of Sounds" row.** `SoundListRow` groups the phonology inventory's
phonemes by category (consonants, vowels, and finer groups the inventory
supports) and marks each as "has glyph" or "missing", with a quick-add that
creates a blank glyph pre-mapped to that phoneme. It is fed by the phonology
inventory through the phoneme-id mapping.

**Vector editor.** `GlyphCanvas` renders the outline as SVG paths in the view
with zoom, pan, grid snapping and metric guide lines (baseline, x-height,
cap-height, ascender, descender). `Toolbox` holds the tools: pen with Bezier
handles, direct select, node modifiers, shapes (rectangle, ellipse, polygon,
star, line), calligraphic brush, mirror/flip, eraser/knife, transforms (scale,
rotate, shear), align/distribute, layer order; pathfinder (unite, minus front,
intersect, exclude, shape builder). `GlyphMetricsPanel` edits name, mapped
phoneme, codepoint, LSB, RSB, advance width. `GlyphMatrixDrawer` is the batch
glyph matrix.

## IPC commands

New commands in `src-tauri/src/commands/writing.rs`, mirroring the phonology
surface, with typed wrappers in `src/lib/api.ts`:

- `writing_get` / `writing_set` — read/replace `config/writing` (the config
  section, like `phonology`; added to `WritableConfigSection`).
- `writing_glyph_get(id)` / `writing_glyph_set(outline)` — load/save one glyph
  outline file.
- `writing_glyph_create(meta)` / `writing_glyph_delete(id)` /
  `writing_glyph_rename(id, name)` / `writing_glyph_reassign(id, phonemes)`.
- `writing_codepoint_allocate(count)` / `writing_codepoint_check(cp)` — PUA
  allocation with collision checks.
- `writing_preview_word(word)` / `writing_preview_text(text)` — evaluate a word
  string through the orthography rules to a glyph sequence (for the translator
  and glossing views).
- `writing_export_font(path, format)` — compile TTF/OTF and read it back for
  validation before returning.
- `writing_export_profile(path)` — the writing-system JSON profile.
- `writing_path_union` / `writing_path_intersect` / `writing_path_difference` /
  `writing_path_exclude` / `writing_path_combine` — boolean ops in Rust (stage
  6).

## `data-changed` scopes

A new `writing` scope is emitted by any writing-system mutation; the frontend
refreshes the writing tab, the glyph grid, and any open preview. Glyph outline
edits additionally mark the workspace dirty for the editor's own undo (but do
not bump the git autocheckin more than the normal config write would). The
scope table in `docs/IPC.md` gains a `writing` row when the commands land
(implementation stage, not this document).

| scope | emitted by | frontend action |
|---|---|---|
| `writing` | glyph/rule/mapping/direction edits, font export | refresh writing tab, glyph grid, previews |

## Risks

- **Boolean operations on cubics** (decision 10) are the riskiest technical
  piece: numerical instability on degenerate contours can corrupt an outline.
  Mitigation: the stage-6 prototype spike, winding normalisation after every op,
  and read-back validation with `read-fonts`.
- **Codepoint collisions** with other fonts or the user's own glyphs. Mitigation:
  automatic stable allocation with checks, user override, and a warning on
  conflicts.
- **Silent data loss on reassign/delete** (the name-keyed bug class).
  Mitigation: stable ids everywhere, broken-dependency flags (decision 12), and
  the trash path for deletes.
- **Preview diverging from the exported font.** Mitigation: preview from the
  live outlines plus a FontFace verification of the compiled font (decision 8).
- **Scope creep** (brushes, transforms, pathfinder, positional forms are a lot).
  Mitigation: the staged plan below ships the smallest useful slice first; each
  stage is independently shippable.

## Suggested stage plan, smallest first

Each stage is independently shippable and verifiable. Tests are cargo tests
(`crates/**`), node tests (`src/lib/**/*.test.ts`), and probes
(`probes/probe.mjs`).

1. **Data model, storage and profile.** `WritingConfig`, `GlyphOutline`, the
   `writing/` directory, `config/writing`, `Phoneme.id` backfill, and `Profile`
   v3 import/export.
   - *Tests:* cargo round-trips for every type; profile v1/v2/v3 import and
     backfill; phoneme id backfill on load; per-glyph file atomic write.
   - *Probes:* open a workspace with a hand-edited `config/writing`, see the
     default config and a quarantine banner on a broken file.
2. **Glyph grid, phoneme mapping, context menu.** The `WritingSystemView` tab
   (singleton, reveal-not-duplicate), `GlyphGrid`, `SoundListRow`, and the
   `glyph` context-menu kind with the full dismissal contract.
   - *Tests:* node tests for `isSingletonTab("writing")`, duplicate-tab reveal,
     glyph ordering; probe for Escape/outside-click/arrow dismissal of the glyph
     menu.
   - *Probes:* open the tab twice and reveal, right-click a tile and dismiss.
3. **Minimal vector editor.** Pen, direct select, node edit, rectangle/ellipse,
   metric guides, grid snap, and the separate undo stack.
   - *Tests:* node tests for the geometry/command layer (move node, add contour,
     undo/redo), cubic-vs-view y-flip, derived LSB/RSB from bounds.
   - *Probes:* draw a path, undo, snap to grid, verify metric guide SVG
     geometry.
4. **Preview in the translator.** `writing_preview_word` through the rule
   engine, wired into the translator and glossing views.
   - *Tests:* cargo tests for the orthography rule evaluator reusing the
     phonology tokenizer/matcher; node test for `<use>` glyph-sequence rendering.
   - *Probes:* a mapped word renders its glyph sequence; a missing glyph shows a
     placeholder.
5. **Font export with validation.** `write-fonts` + `fea-rs` compile a TTF with
   cmap/hmtx/GSUB; read it back with `read-fonts`/`skrifa` before returning.
   - *Tests:* cargo tests parse the exported font and assert cmap entries,
     advance widths and GSUB substitution; probe that the export button writes a
     file and reports validation.
6. **Pathfinder.** `flo_curves` booleans behind `writing_path_*` commands, with
   the prototype spike run first.
   - *Tests:* cargo tests union/intersect two cubics and assert the result keeps
     curves and normalises winding.
7. **Brush, transforms and batch tools.** Calligraphic brush, mirror/flip,
   scale/rotate/shear, align/distribute, layer order, and the batch matrix
   drawer.
   - *Tests:* node tests for transform math and batch actions; probe for
     multi-select count and batch export.
8. **Positional forms and substitution rules.** Contextual GSUB for joining
   scripts, positional-form glyph sets, and their editor UI.
   - *Tests:* cargo tests for form selection by context; probe for a joining
     script rendering the correct contextual form.

## Questions to answer before code

1. Should the JSON profile be able to *optionally* embed glyph outlines, or do
   outlines always stay in `writing/glyphs/` (traveling only with the workspace
   and zip export)?
2. Is PUA allocation per-language (U+E000 upward) with a fixed ceiling, or
   should it avoid a configurable range (e.g. respect a user's existing PUA
   use)?
3. Does v1 need a romanisation-only preview toggle (phoneme symbols vs Latin
   romanisation rendered in the script), or is the romanisation always the
   preview input?
4. Should positional forms (stage 8) ship for all joining scripts or only be
   opt-in per writing system?
5. Is TTF (quadratic) the only v1 export, or should CFF/OTF be included from the
   start?
6. How fine-grained should the phonology "finer groups" in the Lists-of-Sounds
   row be (fricatives, stops, …), and should that grouping be user-defined or
   derived from the inventory?
7. What is the exact set of batch actions for multi-select (the brief proposes
   edit/export/reassign/delete/set metrics — confirm or change)?
8. Should the glyph context menu's extra items be Duplicate, Set Metrics, Clear
   Codepoint, or a different set?
