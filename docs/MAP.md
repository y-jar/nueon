# Source map

Auto-generated from the one-line module headers (`//!` / `<!-- -->`) by
`scripts/gen-map.mjs`. Do not edit by hand; edit the header in the source file
and regenerate.

## `src`

- `App.svelte` — Root component: shell, layout, global keybinds and error surfacing.
- `main.ts` — App entry point: initialises i18n and mounts the Svelte root.
- `vite-env.d.ts` — Vite client type declarations.

## `src/components`

- `ActivityBar.svelte` — Activity ribbon and workspace/settings buttons.
- `AddWordModal.svelte` — Modal to add a new word to a table.
- `CommandPalette.svelte` — Ctrl+P palette of recent notes, tables and actions.
- `CompositionMatrix.svelte` — CJK-style composition matrix: combine two radicals per cell.
- `ConfirmDialog.svelte` — Shared confirm dialog with optional suppression.
- `ContextMenu.svelte` — The portaled context menu for all menu kinds.
- `DeleteWordModal.svelte` — Dependent-aware word delete with reassign.
- `DerivationGraph.svelte` — Ancestor/descendant etymology graph.
- `Editor.svelte` — Note editor: toolbar, codemirror, link follow.
- `EditorMenuBar.svelte` — Editor menu bar: File/Edit/View/Tools/Metrics/Glyphs/Export dropdowns.
- `EditorStatusBar.svelte` — Editor status bar: live status, node count and canvas buttons.
- `EditorToolbar.svelte` — Formatting toolbar for the note editor.
- `EmptyState.svelte` — Empty pane: new note/table shortcuts.
- `ExplorerTree.svelte` — The notes tree with inline rename and drag.
- `FileViewer.svelte` — Image/audio/video/archive viewer.
- `FontReportDialog.svelte` — Font export report: problems found per glyph, with a gated export button.
- `GitPanel.svelte` — Source Control: status, diff, history and check-in.
- `GlyphCanvas.svelte` — Canvas with typographic guides, the drawing surface and node overlay.
- `GlyphGrid.svelte` — Wrapping grid of glyph tiles for the selected group.
- `GlyphGridTray.svelte` — Bottom tray of glyph thumbnails, with multi-select batch actions.
- `GlyphMetricsPanel.svelte` — Glyph metrics: active phonemes, side bearings and advance width.
- `GlyphNavigatorTree.svelte` — Glyph groups and sound coverage for the writing system.
- `GlyphTile.svelte` — One glyph tile in the writing-system grid.
- `Grid.svelte` — The virtualized dictionary grid.
- `GridCell.svelte` — One dictionary grid cell renderer.
- `GroupBody.svelte` — The active view (editor/grid/etc) for a tab group.
- `GroupPane.svelte` — One split pane: tab bar, body, drop edges.
- `Inspector.svelte` — The right-hand context inspector.
- `InterlinearGloss.svelte` — Leipzig-style interlinear gloss view.
- `KeybindCaptureModal.svelte` — Modal that captures a key chord.
- `MorphologyPanel.svelte` — Morphology activity: classes, morphemes, paradigms.
- `MorphologyView.svelte` — Morphology view wrapper (panel + preview).
- `Onboarding.svelte` — First-run workspace picker/onboarding.
- `OrthographyRules.svelte` — Orthography rules: letters in, glyphs out, in an optional context. Order matters.
- `PathfinderPanel.svelte` — Pathfinder panel: boolean operations over a glyph's shapes.
- `PhonologyView.svelte` — Phonology: IPA chart and sound changes.
- `PillCell.svelte` — tag_list cell as pills with suggestions.
- `Popover.svelte` — Anchor popover with click-outside/Escape dismissal.
- `QuarantineBanner.svelte` — Banner for unloadable dictionary files.
- `RadicalPalette.svelte` — Radical palette: reusable components to insert into the active glyph.
- `Settings.svelte` — Settings content: language, tables, keybinds.
- `SettingsModal.svelte` — Settings modal shell with Escape handling.
- `SetupWizard.svelte` — First-workspace setup wizard.
- `Sidebar.svelte` — Notes explorer sidebar.
- `SidebarHost.svelte` — Host showing the active activity's sidebar.
- `SplitView.svelte` — Split-pane container over the tab groups.
- `SuggestInput.svelte` — Input with a suggestion dropdown.
- `SuggestionList.svelte` — The suggestion dropdown list.
- `TabBar.svelte` — Tab bar: reveal, keyboard nav, drag, close, new.
- `TablesPanel.svelte` — Dictionary tables sidebar list.
- `Toast.svelte` — Transient status toast.
- `Toolbox.svelte` — Toolbox: the drawing tools and the options of the active tool.
- `TransformDialog.svelte` — Transform dialog: numeric move, scale, rotate and skew, with an optional copy.
- `Translation.svelte` — Translation activity: builder + runner.
- `TrashModal.svelte` — Trash bin modal (restore/delete).
- `VectorEditor.svelte` — Vector editor: menu, toolbar, toolbox, canvas, metrics and tray.
- `VectorToolbar.svelte` — Vector toolbar: undo/redo, zoom, snap, compose and SVG import/export.
- `WritingPanel.svelte` — Writing System activity: searchable glyph list with sound coverage.
- `WritingSystemView.svelte` — Writing System: glyph navigator, grid, and vector editor.

## `src/components/import`

- `ImportWizardModal.svelte` — CSV/TSV/JSON import wizard shell.

## `src/components/import/steps`

- `StepMapping.svelte` — Import step: map source columns to tags.
- `StepPreview.svelte` — Import step: preview parsed rows.
- `StepReport.svelte` — Import step: result report.
- `StepSelect.svelte` — Import step: pick file and format.

## `src/components/translation`

- `ClauseCanvas.svelte` — Drag-and-drop clause construction grid.
- `ComposeBuilder.svelte` — Compose word-from-roots builder.
- `FeatureBar.svelte` — Feature selection bar for paradigms.
- `FeatureEditor.svelte` — Feature and paradigm editor.
- `MorphologyDrawer.svelte` — Drawer of morphemes for slot filling.
- `ParadigmGrid.svelte` — Paradigm (feature x slot) grid.
- `SaveWordForm.svelte` — Form to save a composed word.
- `SlotCard.svelte` — One clause slot card.
- `SlotPalette.svelte` — Palette of draggable slots.
- `TranslationRunner.svelte` — The English-to-conlang runner.
- `TranslationToolbar.svelte` — Translation toolbar: preset/mode controls.
- `types.ts` — Shared types for the translation UI.
- `WordPicker.svelte` — Homograph conflict word picker.

## `src/lib`

- `actions.ts` — Svelte actions: autofocus and small DOM behaviours.
- `api.ts` — Typed Tauri IPC wrappers and request/response models.
- `app-environment.ts` — Build/runtime environment flags.
- `assets.ts` — Asset path handling and note-relative asset links.
- `compose.ts` — Compose helpers: root discovery and default save table.
- `configEdit.ts` — Parsing helpers for editable config (symbols, sound classes).
- `context.svelte.ts` — Context menus, inline rename/new requests and section collapsing.
- `data.svelte.ts` — Workspace data loading: refresh, initial load and workspace switching.
- `dictionary.ts` — Dictionary column types and part-of-speech classes.
- `errors.ts` — Classifies browser errors that are noise and must not reach the error bar.
- `explorer.ts` — Note-tree helpers: flattening, name stripping, unique paths.
- `exports.ts` — Profile/workspace export and import dialogs.
- `feedback.svelte.ts` — User feedback and preferences: confirmation dialogs, toasts, suppressed
- `fileActions.ts` — Reveal in the file manager and open in the default app.
- `fileDrop.ts` — OS file-drop onto the workspace (the drop bridge).
- `files.ts` — Whole-file text read/write through the Tauri backend (for SVG import/export).
- `fontReport.ts` — Pure helpers for the font export validation report.
- `gridView.ts` — Grid column visibility/sort/width normalization.
- `history.ts` — A small snapshot undo/redo stack, separate from the app's git history.
- `i18n.ts` — Locale initialisation for svelte-i18n.
- `ipa.ts` — IPA chart data and phoneme feature helpers.
- `keybindings.ts` — Keybinding definitions, formatting and reserved combos.
- `layout.svelte.ts` — Tiling layout: tab drag between panes/windows, split/merge and persistence.
- `morphology.svelte.ts` — Morphology store: classes, morphemes, paradigms and compose.
- `notes.svelte.ts` — Note, folder and asset operations, and change/conflict handling.
- `raw.d.ts` — Module declarations for assets imported without types.
- `shell.svelte.ts` — Shell chrome: the activity ribbon, panels and modal toggles.
- `spellcheck.ts` — English misspelling guard for `definition` fields (PSD §B).
- `state.svelte.ts` — Public state API re-exported for components.
- `store.svelte.ts` — The reactive ui store and shared domain types.
- `suggest.ts` — Value-suggestion filtering for tag_list/text cells.
- `tabs.svelte.ts` — Opening, activating and closing tabs, and their table operations.
- `tabs.ts` — Pure tab helpers: pruning, identity and singleton checks.
- `tiling.ts` — Split layout: indices, serialization and tree helpers.
- `wikilink.ts` — Pure [[...]] link parsing, ranking and resolution.
- `window.ts` — Current window label and main-window flag.
- `words.ts` — Word creation and value editing helpers.
- `writing.ts` — Pure writing-system helpers: glyph grouping, ordering and geometry.
- `writingBatch.ts` — Pure batch operations over the glyph index (multi-select actions).
- `writingBezier.ts` — Bezier editing helpers for the Direct tool: segment drag, handle visibility, hit priority, extrema.
- `writingCommands.ts` — Pure edit operations on glyph outlines: nodes, shapes, transforms, brush.
- `writingComponents.ts` — Pure component resolution for the glyph canvas: transform, flatten, expand.
- `writingEditor.svelte.ts` — Vector-editor state: the open glyph, tools, selection, history and gestures.
- `writingForms.ts` — Pure helpers for a glyph's positional forms (initial, medial, final).
- `writingMenus.ts` — Pure menu definitions for the vector editor's menu bar.
- `writingNodeType.ts` — Setting a node's type (corner, smooth, symmetric), growing handles when it has none.
- `writingRules.ts` — Pure helpers for editing orthography rules in the writing tab.
- `writingSelect.ts` — Element-level selection for the Select tool: hit testing, marquee, move, duplicate.
- `writingSidebar.ts` — Pure filtering and grouping for the Writing System sidebar glyph list.
- `writingSnap.ts` — Pure snapping: nodes, guide rails, bearing lines, edge midpoints and the grid.
- `writingTransform.ts` — Pure transform maths for the Select tool's transform box and the Transform dialog.
- `writingViewport.ts` — Pure viewport math for the glyph canvas: zoom about a point, pan, fit.

## `src/lib/editor`

- `action.ts` — The codemirror Svelte action: one live editor per note.
- `blocks.ts` — Block detection: fenced code and table regions.
- `brackets.ts` — Bracket auto-closing language data.
- `commands.ts` — Markdown formatting commands and keymap.
- `dictionary.ts` — Dictionary word index field and highlight/hover.
- `diff.ts` — Minimal whole-document splice diff.
- `freshness.ts` — Read generations guarding stale file reads.
- `livePreview.ts` — Live-preview decorations (images, math, blocks).
- `multiselect.ts` — Ctrl/Cmd-click multi-cursor support.
- `positions.ts` — Remember and recall cursor/scroll per note.
- `session.ts` — Save-decision helpers for stale editor buffers.
- `table.ts` — Markdown table parsing helpers.
- `tableEditing.ts` — Markdown table editing commands.
- `theme.ts` — Editor theme and syntax highlighting.
- `wikiLinks.ts` — [[...]] decoration, autocomplete and hover.

