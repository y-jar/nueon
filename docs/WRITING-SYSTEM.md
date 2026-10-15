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

## The thirteen decisions

### 1. Storage: per-glyph files plus an index

- **Recommendation.** A `writing/` directory with one JSON file per glyph
  (`writing/glyphs/<id>`) holding the outline and metrics, and a small
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
- **Outlines only.** Strokes are not stored: the calligraphic brush and pen
  expand a stroke to closed contours immediately, so the outline model stays
  contour-only and pathfinder/export never reason about centreline strokes.

### 4. Writing direction and positional forms

- **Recommendation.** A writing-system-level direction of `ltr`, `rtl`, or
  `ttb`. Positional forms (isolated/initial/medial/final for joining scripts)
  are **deferred past v1** and only designed (see stage 9).
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
- **SVG export.** Glyphs and the whole set can also be exported as SVG — one
  `<path>` per glyph, or a `<symbol>` sprite sheet — reusing the preview's
  symbol table (decision 8), so a writing system can be shared or embedded on
  the web without a font install.

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
- **Font crates (stage 6, built).** `write-fonts` 0.54, `read-fonts` 0.45 and `kurbo` 0.13 (all MIT OR Apache-2.0, MSRV 1.85 against our 1.95) compile and verify the TTF. `fea-rs` is not needed until GSUB (stage 9).
- **Prototype spike (stage 7, before committing to it).** The riskiest crate is
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

### 13. Components (radicals)

- **Recommendation.** A glyph may reference other glyphs as **component
  instances**: a `ComponentInstance` holding a target glyph id and a transform
  (translate, scale, rotate, mirror). Components are authored in the Radical
  Palette and assembled into glyphs through the Composition Matrix (CJK-style
  composition). The component graph must stay **acyclic** — a glyph cannot
  directly or indirectly contain itself — enforced on save.
- **Flatten when needed.** Components stay as references (like TrueType `glyf`
  composites) while editing and exporting, keeping the font small and the
  glyphs faithful. They are expanded to contours only when an operation needs
  real geometry: pathfinder booleans, bounds/metric derivation, and any CFF
  (non-composite) output path.
- **Dependency safety.** Deleting or renaming a component glyph flags every
  glyph that instanced it as broken, exactly as decision 12 does for rule/word
  dependents — never silently dropped.
- **Why.** Constructed scripts are built from a small set of recurring
  strokes/radicals; without references, every radical edit must be manually
  propagated to each glyph that uses it, and the font stores duplicate
  outlines. Acyclic validation mirrors the dictionary's parent-graph discipline
  and prevents infinite expansion on export.

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

/// A reusable glyph referenced inside another glyph (TrueType-composite-like).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ComponentInstance {
    /// Glyph id of the component.
    pub glyph: String,
    pub dx: f64,
    pub dy: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotation: f64,
}

/// One element of a glyph: a contour or a component instance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutlineElement {
    Contour(Contour),
    Component(ComponentInstance),
}

/// A glyph's vector data, stored one-per-file in `writing/glyphs/<id>`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GlyphOutline {
    pub elements: Vec<OutlineElement>,
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
    /// Stable id; the outline file is `writing/glyphs/<id>`.
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
    /// Navigator group: a phonology category, a user folder, or `radicals`.
    #[serde(default)]
    pub group: String,
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

export interface ComponentInstance {
  glyph: string;
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

export type OutlineElement =
  | ({ kind: "contour" } & Contour)
  | { kind: "component"; component: ComponentInstance };

export interface GlyphOutline {
  elements: OutlineElement[];
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
  group: string;
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
  writing/glyphs/<id>  one GlyphOutline per glyph (large, atomic per-glyph).
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
WritingSystemView.svelte                 (tab body; owns config + open glyph id)
├── GlyphNavigatorTree.svelte            left: glyph/radical tree grouped by category
│     └── RadicalPalette.svelte          reusable components, drag into canvas
├── WritingHeader.svelte                 Add / Export, multi-select mode + count
├── GlyphGrid.svelte                     grid of tiles for the selected group
│     └── GlyphTile.svelte               preview, left-click open, right-click menu
├── CompositionMatrix.svelte             assemble glyphs from radicals (CJK-style)
└── VectorEditor.svelte                  (opened from a tile / matrix)
      ├── EditorMenuBar.svelte           File / Edit / View / Tools / Metrics / Glyphs / Export
      ├── EditorToolbar.svelte           tool picker, zoom, snap toggle
      ├── Toolbox.svelte                 pen/select/nodes/shapes/brush/transforms
      ├── GlyphCanvas.svelte             zoom/pan/grid-snap/metric guides, tool input
      ├── GlyphInspector.svelte          name, id, path/nodes/segments, phoneme, codepoint
      ├── PathfinderPanel.svelte         merge/minus/exclude/intersect
      ├── ExportHub.svelte               format (SVG/font), target, scale, compile
      └── EditorStatusBar.svelte         active glyph, counts, canvas, snap
```

**State ownership.** The `WritingSystemView` owns the `WritingConfig` and the
open glyph id. The `VectorEditor` owns the *editing* state for the open glyph:
the `$state.raw` outline, the selection, the active tool, and the undo/redo
stack. The pure geometry/command layer (`src/lib/writing/`) owns no DOM and no
Svelte state — components call into it and render its results. On a finished
gesture, the editor commits the glyph through one IPC call; there is no IPC on
pointer move.

**Navigator and glyph grid.** `GlyphNavigatorTree` groups glyphs by category
(phonology-derived consonant/vowel groups, user folders, and the `radicals`
group) from each glyph's `group` field; the tree marks each phoneme as "has
glyph" or "missing" with a quick-add, like the earlier Lists-of-Sounds row.
`GlyphGrid` renders the selected group's glyphs (ordered by `order`) as
`<symbol>`/`<use>` tiles that wrap in a grid. Left-click opens a glyph in the
editor; right-click opens the `glyph` context-menu kind (Edit, Delete, Reassign
Phoneme, plus Duplicate, Set Metrics, Clear Codepoint — proposed additions).
Multi-select toggles a "count selected" mode in `WritingHeader` with batch
actions: Edit selected, Export selected, Reassign, Delete, Set metrics.

**Radicals and the composition matrix.** `RadicalPalette` lists the glyphs
marked as components; dragging one into `GlyphCanvas` inserts a
`ComponentInstance` into the open glyph. `CompositionMatrix` assembles a new
glyph CJK-style from radicals — pick a component per cell to build up a glyph
and save it. Components are references (decision 13): editing a radical updates
every glyph that instances it, until the user explicitly expands an instance to
contours.

**Vector editor.** `GlyphCanvas` renders the outline as SVG paths in the view
with zoom, pan, snapping (nodes, rails, edge lines, grid) and metric guide lines (baseline, x-height,
cap-height, ascender, descender). `Toolbox` holds the tools: pen with Bezier
handles, direct select, node modifiers, shapes (rectangle, ellipse, polygon,
star, line), calligraphic brush, mirror/flip, eraser/knife, transforms (scale,
rotate, shear), align/distribute, layer order. `PathfinderPanel` holds the
booleans (merge, minus, exclude, intersect). `GlyphInspector` edits name, id,
mapped phoneme, codepoint, and reports path/nodes/segments counts, LSB, RSB,
advance width. `ExportHub` sets format (SVG/font), target, scale (1000 upem),
and compiles the font.

## Editor interaction model (polish pass)

### Viewport

The canvas keeps a view `{ cx, cy, scale }` (`src/lib/writingViewport.ts`): the
glyph point shown at the canvas centre and screen pixels per font unit, so 100%
means one unit per pixel. The SVG `viewBox` is derived from it and the measured
canvas size, so it always has the canvas aspect ratio (no letterboxing, no
stretched handles). Zoom runs 0.1 to 32 (10% to 3200%). Wheel, click and box
zoom keep the glyph point under the cursor fixed; pan is a screen-pixel drag.
The first version of this editor changed only the viewBox width and scrolled an
`overflow: hidden` box, so it zoomed toward the top-left corner and Space or
middle-drag pan did nothing; that claim in earlier notes was never verified in
the running app. It is now covered by probes 105 to 110.

### Selection state

Two selections exist side by side, and only one is non-empty at a time:

```ts
editor.elements: number[]        // whole elements (contours or components), sorted
editor.selection: NodeRef[]      // { element, node } for single nodes (Direct tool)
```

The Select tool writes `elements` and clears `selection`; the Direct tool does
the opposite. Delete, arrow-key nudge and Ctrl+D act on whichever is non-empty.
`editor.selectedComponent` (a single component for "Expand component") is kept
separate for now. Indexes are pruned after undo and redo. The pure functions
(`hitElement`, `elementsInBox`, `translateElements`, `duplicateElements`) are in
`src/lib/writingSelect.ts`. Hit testing uses non-zero winding over the whole
outline, so a hole is a miss, an open contour counts as filled (as the canvas
and the font do), and the edge has a tolerance of the node radius in font units.

### Transform box

With shapes selected in the Select tool, a box with handles surrounds them
(`src/lib/writingTransform.ts`, pure and unit-tested):

| Handle | Drag | Modifiers |
| --- | --- | --- |
| Corner square | Scale about the opposite corner | Shift keeps the ratio, Alt scales about the pivot |
| Just outside a corner | Rotate about the pivot by the angle swept | Shift snaps the total to 15 degrees |
| Edge circle | Skew along that edge, pivot fixed | |
| Crosshair | Move the pivot (snaps) | |

The pivot is the centre of the box until it is dragged, and resets when the
selection changes. Reach is measured in screen pixels (scale 6, edge 6, pivot 5,
rotate ring 22), so handles stay easy to hit at any zoom, and the rotate ring
exists only outside the box so a click inside near a corner still moves the
shape. While a handle is dragged the outline is not written: a live matrix is
shown (`previewOutline`) and applied once on release, so a whole drag is one undo
step and one save. Snapping moves the pointer used for scale and skew; rotation
uses the raw pointer.

A component instance stores only a move, a uniform scale and a rotation, so a
skew, flip or stretch cannot be folded into it. Such components are left alone
and the status bar says how many. Scaling a group by the same factor on both axes
works on components.

### Transform dialog

Edit > Transform... (Ctrl+Shift+M) takes move, scale (percent), rotate and skew
in degrees, applied in the order scale, skew, rotate, then move, about the pivot
handle if it was set and otherwise the centre of the target. With nothing
selected it acts on every shape. "Copy" transforms appended copies and keeps the
originals. One undo step either way. Scale of 0 or an unparsable value is treated
as 100% so a half-typed field cannot collapse the shape.

### Node types

Corner, Smooth and Symmetric are set with the buttons in the properties panel,
the Tools menu, or Node Mod (click cycles). Smooth keeps each handle's length and
keeps the pair collinear; Symmetric makes both the same length; Corner keeps
whatever handles exist. A node with no handles grows them along the line from the
previous to the next node, a third of the nearer neighbour's distance long, so a
handle never reaches past the next node (an open end gets its one handle).
Symmetric nodes are drawn as diamonds, smooth as circles, corners as squares
(`data-kind` on each node for tests).

### Bezier editing (Direct tool)

Pure logic is in `src/lib/writingBezier.ts`.

- **Handles are shown only where they matter.** A selected node shows both of its
  handles, and each neighbour shows only the handle that faces it (wrapping round
  a closed contour). `Shift+H` shows every handle. A handle of an unselected node
  can never be grabbed.
- **Targets.** Node reach 10 screen px, handle 12 px, segment 8 px; drawn node
  half-size 5 px, handle dot radius 4 px. The hovered node or handle grows and
  turns the accent colour, and a hovered segment is highlighted.
- **Hit priority.** Nearest node first, then handle, then segment. If a node and
  a handle are both in reach, the node wins, unless that node is already selected
  and the pointer is more than 4 px from its centre (so a short handle cannot
  steal a click on its node, yet a long-selected node's handle is still reachable).
- **Drag a curve segment** to reshape it. With the pointed-at parameter `t`
  fixed (clamped to 0.1..0.9), both control points move by the least amount that
  carries that point with the pointer: `d * Bi / (B1^2 + B2^2)`, `B1 =
  3(1-t)^2 t`, `B2 = 3(1-t) t^2`. The end nodes do not move, smooth and symmetric
  neighbours keep their constraint, and a straight segment first becomes a curve
  with handles at a third and two thirds. One drag is one undo step.
- **Alt-drag from a node** pulls out two equal, opposite handles (the node becomes
  symmetric). **Double-click a node** toggles corner and smooth (smooth grows
  handles, corner retracts them).
- **Handle drags.** Shift constrains the handle's angle to 0, 45 or 90 degrees,
  Ctrl to 15. Smooth and symmetric nodes keep their constraint; holding Alt breaks
  it for that drag (only that handle moves and the node becomes a corner).
- **Add extrema** (Tools menu, Ctrl+Shift+X) inserts a node at every horizontal and
  vertical extremum of the curves in the selection (the selected nodes' contours,
  else the selected shapes, else every shape), by exact subdivision, so the shape
  is unchanged and each new node has a horizontal or vertical tangent.

### Tools and shortcuts

| Key | Tool / action | Notes |
| --- | --- | --- |
| V | Select | Default when a glyph opens |
| A | Direct Select | Nodes and handles |
| H | Hand | Drag to pan |
| Z | Zoom | Click in, Alt-click out, drag a box to fit it |
| P | Pen | Ctrl constrains the segment angle to 15 degrees |
| N | Node Mod | |
| B | Brush | |
| S | Shapes | |
| M | Mirror/Flip | |
| E | Eraser | |
| Space (held) | Temporary Hand | Returns to the chosen tool on release |
| Middle-drag | Pan | In any tool |
| Ctrl+wheel | Zoom about the cursor | sqrt(2) per notch |
| 0 | Fit glyph | Also Ctrl+F |
| 1 | 100% | |
| Shift+H | Show all handles | Otherwise only selected nodes (and facing neighbours) show handles |
| Ctrl+Shift+X | Add extrema | Direct tool; selection, else shapes, else all |
| Alt-drag a node | Pull out symmetric handles | Direct tool |
| Double-click a node | Toggle corner / smooth | Direct tool |
| Shift/Ctrl-drag a handle | Constrain to 45 / 15 degrees | Alt breaks the node's constraint |
| Arrows, Shift+Arrows | Nudge 1 or 10 units | Shapes (Select) or nodes (Direct) |
| Tab, Shift+Tab | Step through nodes | |
| Ctrl+A | Select all | Shapes in Select, nodes otherwise |
| Ctrl+D | Duplicate | Offset by 20 units; the copies become the selection |
| Delete | Delete selection | Ctrl+Delete removes a node without refitting the curve |
| Shift+J / Shift+B | Join endpoints / break node | |
| Ctrl+Shift+E | Expand component | |
| Ctrl+Shift+M | Transform dialog | |
| Shift-drag a corner | Keep ratio | Transform box |
| Alt-drag a corner | Scale from the pivot | Transform box |
| Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y | Undo, redo | |
| Enter, Esc | Finish path, cancel | |

Reserved for later: K knife, R measure, F freehand (stage 7). Every tool
shortcut is a bare letter not used by another binding; `RESERVED_KEYS` and a
test in `src/lib/writing.test.ts` guard that.


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
- `writing_export_svg(path, scope)` — export glyphs as SVG (one `<path>` per
  glyph, or a `<symbol>` sprite sheet), for sharing and web embedding.
- `writing_flatten(glyph_id)` — expand every component instance in a glyph to
  raw contours, used before pathfinder/CFF and by the editor's "expand" action.
- `writing_export_profile(path)` — the writing-system JSON profile.
- `writing_path_union` / `writing_path_intersect` / `writing_path_difference` /
  `writing_path_exclude` / `writing_path_combine` — boolean ops in Rust (stage
  7). These (and `writing_flatten`) expand components first.

Acyclic-component validation runs inside `writing_set` / `writing_glyph_set`: a
save that would close a reference cycle is rejected with an error naming the
cycle, rather than written.

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
  Mitigation: the stage-7 prototype spike, winding normalisation after every op,
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

## Testing & validation via probes

Geometry, component graphs, and font compilation cannot be trusted to visual
inspection alone. Alongside the usual cargo and node tests, the writing system
gets a set of deterministic **structural probes** — the existing WebDriver probe
harness (`probes/probe.mjs`) for the UI paths, plus Rust integration tests for
the data-integrity checks that have no UI. Four probe categories:

- **Acyclic component probes.** Inject a reference cycle (glyph A → B → A) and
  assert that the save is rejected instantly with an error naming the cycle —
  the same save path `writing_set`/`writing_glyph_set` uses. A cargo test,
  because no UI is involved.
- **SVG serialization probes.** Run headless serialization over `OutlineElement`
  vectors containing mixed contours and component instances, and assert the
  `<symbol>` sprite sheet and standalone `<path>` output parse without malformed
  or `NaN` coordinates. Cargo test (serialization) plus a probe that loads the
  exported SVG.
- **Flattening / pathfinder probes.** Assert that a component instance expands
  into raw contours at the correct translation, scale, and rotation before
  `flo_curves` booleans run, and that the boolean result keeps cubic curves and
  normalised winding. Cargo test around `writing_flatten` and the `writing_path_*`
  commands.
- **State-consistency (IPC) probes.** Rust integration tests verify that the
  frontend store action → Tauri command dispatch round-trips glyph metrics
  (advance, lsb, rsb) without dropping or reordering them, and that the
  `data-changed` `writing` scope fires on every mutation so the frontend never
  goes stale.

## Suggested stage plan, smallest first

Each stage is independently shippable and verifiable. Tests are cargo tests
(`crates/**`), node tests (`src/lib/**/*.test.ts`), and probes
(`probes/probe.mjs`); the four structural probe categories above are cited
inline where they apply.

1. **Data model, storage, profile + component structures + SVG export pipeline.**
   `WritingConfig`, `GlyphOutline` with `OutlineElement`/`ComponentInstance` and
   acyclic validation, the `writing/` directory, `config/writing`,
   `Phoneme.id` backfill, and `Profile` v3 import/export.
   - *Tests:* cargo round-trips for every type; profile v1/v2/v3 import and
     backfill; phoneme id backfill on load; per-glyph file atomic write.
   - *Probes:* acyclic-component probe; open a workspace with a hand-edited
     `config/writing`, see the default config and a quarantine banner on a
     broken file.
2. **Tree navigator + glyph grid integration.** The `WritingSystemView` tab
   (singleton, reveal-not-duplicate), `GlyphNavigatorTree`, `GlyphGrid`,
   phoneme mapping, and the `glyph` context-menu kind with the full dismissal
   contract.
   - *Tests:* node tests for `isSingletonTab("writing")`, duplicate-tab reveal,
     grouping/ordering; probe for Escape/outside-click/arrow dismissal of the
     glyph menu.
   - *Probes:* open the tab twice and reveal, right-click a tile and dismiss;
     state-consistency probe that opening the tab dispatches `writing_get`.
3. **Radical palette, composition matrix, pathfinder panel (UI).** The three new
   surfaces: component insert/instance/expand, CJK-style assembly, and the
   persistent pathfinder panel wired to the stage-7 boolean commands.
   - *Tests:* node tests for the composition-matrix assembly and component
     insert producing the right `OutlineElement`; probe for drag-into-canvas
     inserting a `ComponentInstance`.
4. **Minimal vector editor.** Pen, direct select, node edit, rectangle/ellipse,
   metric guides, grid snap, and the separate undo stack.
   - *Tests:* node tests for the geometry/command layer (move node, add contour,
     undo/redo), cubic-vs-view y-flip, derived LSB/RSB from bounds.
   - *Probes:* draw a path, undo, snap to grid, verify metric guide SVG
     geometry.
5. **Preview in the translator.** `writing_preview_word` through the rule
   engine, wired into the translator and glossing views.
   - *Tests:* cargo tests for the orthography rule evaluator reusing the
     phonology tokenizer/matcher; node test for `<use>` glyph-sequence rendering.
   - *Probes:* a mapped word renders its glyph sequence; a missing glyph shows a
     placeholder.
6. **Font + SVG export with validation.** `write-fonts` + `fea-rs` compile a TTF
   with cmap/hmtx/GSUB (and composites); `writing_export_svg` emits the sprite
   sheet; read the font back with `read-fonts`/`skrifa` before returning.
   - *Tests:* cargo tests parse the exported font and assert cmap entries,
     advance widths and GSUB substitution; SVG-serialization probe.
   - *Probes:* the export button writes a file and reports validation;
     state-consistency probe that metrics (advance/lsb/rsb) survive export.
7. **Pathfinder booleans in Rust.** `flo_curves` behind `writing_path_*`, with
   the prototype spike run first and `writing_flatten` expanding components.
   - *Tests:* flattening/pathfinder probe — union/intersect two cubics and
     assert the result keeps curves and normalises winding.
8. **Brush, transforms and batch tools.** Calligraphic brush, mirror/flip,
   scale/rotate/shear, align/distribute, layer order, and the batch matrix
   drawer.
   - *Tests:* node tests for transform math and batch actions; probe for
     multi-select count and batch export.
9. **Positional forms and substitution rules.** Contextual GSUB for joining
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
4. Should positional forms (stage 9) ship for all joining scripts or only be
   opt-in per writing system?
5. Is TTF (quadratic) the only v1 export, or should CFF/OTF be included from the
   start?
6. How fine-grained should the navigator tree's phonology groups be (fricatives,
   stops, …), and should that grouping be user-defined or derived from the
   inventory?
7. What is the exact set of batch actions for multi-select (the brief proposes
   edit/export/reassign/delete/set metrics — confirm or change)?
8. Should the glyph context menu's extra items be Duplicate, Set Metrics, Clear
   Codepoint, or a different set?
9. When is a component expanded to real contours — always at export, or keep
   TrueType composites and flatten only for pathfinder/CFF?
10. SVG export scope: a single glyph, the whole set as a sprite sheet, or both?
