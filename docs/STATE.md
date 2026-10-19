# Frontend state

Svelte 5 runes. One reactive `ui` object is the single source of truth
(`src/lib/store.svelte.ts`); it is mutated directly by the action modules in
`src/lib/*.svelte.ts` and read reactively by components via `$state` / `$derived`.

## The `ui` store

- **Shell chrome** — `activity`, `sidebarOpen`, `inspectorOpen`/`inspectorDock`,
  `settingsOpen`, `setupWizardOpen`, `showWorkspacePicker`, `paletteOpen`,
  `confirm`, `toast`, `trashOpen`, `importOpen`.
- **Preferences** — `showLineNumbers`, `keybinds` (command id → combo),
  `suppressedConfirms`.
- **Tiling** — `groups: TabGroup[]`, `activeGroupId`, `splitRoot` (a `SplitNode`
  tree), `layoutReady`.
- **Workspace data** — `root`, `tree` (note tree), `tables`, `wordIndex`,
  `nameById`, `fixesTables`, `noteHeadings`, `scrollToHeading`, `quarantine`,
  `revision` (per-scope data-changed counters; see the invalidation registry
  below).
- **Transient UI** — `contextMenu`, `dragPath`, `dragTab`, `renameTarget`,
  `tableRenameTarget`, `newRequest`, `collapseAllSignal`, `status`.

## Types

- `Tab` — `{ id, kind, ref, title }`; `kind` is note/file/table/translation/
  morphology/phonology; `ref` is the note path or table name (`null` for tools).
- `TabGroup` — `{ id, tabs, activeTabId, doc }`.
- `DocState` — the loaded document for a group: `view`, the note (`selected`,
  `noteContent`, `noteHash`, `dirty`, `conflict`) and the table (`currentTable`,
  `table`, `selectedEntry`). One group shows one view at a time.
- `SplitNode` — a leaf (a `groupId`) or a `row`/`column` of children
  (`src/lib/tiling.ts`).

## Ownership rules

- **Tabs** — `tabs.svelte.ts` owns open/activate/close/reorder. `layout.svelte.ts`
  owns drag/split/tear-off and `moveTab`. `shouldPruneGroup` (pure, in `tabs.ts`)
  decides when an emptied pane is removed (only when other panes remain).
- **Notes** — `notes.svelte.ts` owns load/save/conflict; the CodeMirror action
  (`editor/action.ts`) owns the live editor buffer and autosave.
- **Derived, not duplicated** — `wordIndex`/`nameById`/`fixesTables`/`noteHeadings`
  are derived from the workspace on load and on `data-changed` (see `IPC.md`).
- **Mutations go through the action modules**, never straight into `ui` from a
  component, so there is one place to enforce invariants.

## Data-changed invalidation registry

One mechanism keeps every backend-data cache in the frontend fresh
(`src/lib/invalidation.svelte.ts` over the pure core in
`src/lib/invalidation.ts`):

- **Register, don't re-derive.** A store or panel that caches backend data
  registers the scopes that invalidate it: `registerInvalidation({ id,
  scopes, reload, visible?, needsLoad? })`. The listener in
  `data.svelte.ts` routes every `data-changed` event through the registry.
- **Debounce and coalesce.** Reloads run after a 150 ms quiet window, so a
  burst of events (a bulk edit, an import) costs one refetch, not one per
  event.
- **Own writes are skipped for their writer alone.** A mutating write wrapped
  in `withOwnWrite(id, scopes, fn)` suppresses its echo event for that
  consumer; every other consumer still reloads. Stores also compare before
  assigning so a redundant refetch writes nothing reactive.
- **Hidden means stale, not background-fetching.** A consumer that is not on
  screen only goes stale; its components call `consumerShown(id)` on mount,
  which reloads then (and performs the first load via `needsLoad`).
- **Effect-based consumers read `ui.revision`.** The registry bumps a
  per-scope counter on every event; a component that holds a copy in local
  state adds the counter(s) to its `$effect` deps (the seen-guard pattern:
  capture, compare, reload).
- **The shared slices are consumers too.** The workspace, tree, word index,
  fixes tables, tables and open-notes reloaders registered in `init()` ride
  the same registry (they were the listener's old ad-hoc branches).

## Data-changed consumers (audit)

Every frontend store or panel that holds a copy of backend data, and which
`data-changed` scopes reach it. Keep the table in sync when adding a consumer
(see `docs/IPC.md` for the scope table).

| Consumer | Holds | Should invalidate | Reached by | Verdict |
|---|---|---|---|---|
| `MorphologyStore` (`src/lib/morphology.svelte.ts`) | morphology config, morphemes, lexicon | dictionary, config, translation, workspace, vcs | the registry (all five) | fresh |
| `Translation.svelte` | presets, grammar, options, morphology copy | translation, config, dictionary, workspace, vcs | the registry (translation, config, workspace; mounted per tab, own writes suppressed) | fresh |
| `MorphologyView.svelte` local `affixes` | translation options | translation, config | `ui.revision.translation`/`config` (seen-guard) | fresh |
| `translation/ParadigmGrid.svelte` | one class's paradigm grid | translation, config, dictionary | `ui.revision.translation`/`config` | fresh (dictionary refetch rides the store) |
| `PhonologyView.svelte` | phonology config | config | `ui.revision.config` | fresh |
| `WritingPanel.svelte` | writing + phonology config | writing, config, vcs | `ui.revision.writing`/`config` + window focus | fresh |
| `WritingSystemView.svelte` | writing + phonology config, outlines | writing, config, vcs | revision counters + focus + reload guard | fresh |
| `Settings.svelte` (open) | language, grammar, roles, phonology, morphology | config, translation, dictionary | the registry (mounted while the modal is open; own writes suppressed, pending-save guard) | fresh |
| `Inspector.svelte` | phonology copy, known tags | config, dictionary | `ui.revision.config`/`.dictionary` | fresh (draft guards are by design) |
| `translation/FeatureEditor.svelte` | per-column feature values | dictionary | cache wiped on `ui.revision.dictionary` | fresh |
| `Grid.svelte` / `TablesPanel` / quarantine | table data via `doc.table` | dictionary | the dictionary branch | fresh |
| shared slices: `tree`, `wordIndex`, `tables`, `fixesTables` | workspace-derived indexes | notes, dictionary, config, workspace | the registry | fresh |
| `GitPanel.svelte` | vcs state, log, status | vcs, workspace | `ui.revision.vcs` | fresh |
| Editor / open notes | note buffers | notes, vcs | `reloadOpenNotes` + freshness generations | fresh |

Backend emit gaps the audit flagged, since fixed: `vcs_checkout`/
`vcs_revert_file` now emit `config` too (config-derived views refresh after
a checkout), `undo`/`redo` emit `notes` when the applied step rewrote note
files, and `import_asset` emits `notes` like its dialog twin. Still open:
`save_note` emits nothing (an open note in a second window goes stale), and
the pref commands (`set_keybind`, `set_editor_line_numbers`,
`ui_layout_set`, `tiling_save`, `grid_view_set`, `recent_record`) emit
nothing by design — single-window, self-contained consumers.

## Overlays

Overlays are driven by `ui` fields and rendered by their own component:
`contextMenu` (`ContextMenu.svelte`), `confirm` (`ConfirmDialog.svelte`), `toast`
(`Toast.svelte`), `paletteOpen` (`CommandPalette.svelte`), `settingsOpen`,
`setupWizardOpen`, `trashOpen`, `importOpen`. See `UI-CONVENTIONS.md` for the
shared dismissal contract.
