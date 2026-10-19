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
  `vcsRevision`, `phonologyRevision`, `morphologyRevision`.
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

## Data-changed consumers (audit)

Every frontend store or panel that holds a copy of backend data, and which
`data-changed` scopes reach it today. This is the pre-registry audit that
drove the invalidation fix; the registry stage moves the "reached by" column
into explicit scope declarations. Keep the table in sync when adding a
consumer (see `docs/IPC.md` for the scope table).

| Consumer | Holds | Should invalidate | Reached by today | Verdict |
|---|---|---|---|---|
| `MorphologyStore` (`src/lib/morphology.svelte.ts`) | morphology config, morphemes, lexicon | dictionary, config, translation, workspace, vcs | nothing; its own writes only | stale — the reported bug |
| `Translation.svelte` | presets, grammar, options, morphology copy | translation, config, dictionary, workspace, vcs | own saves; `morphologyRevision` | partial |
| `MorphologyView.svelte` local `affixes` | translation options | translation, config | mount only | stale |
| `translation/ParadigmGrid.svelte` | one class's paradigm grid | translation, config, dictionary | `morphologyRevision` | partial |
| `PhonologyView.svelte` | phonology config | config | `phonologyRevision` (Settings only) | partial |
| `WritingPanel.svelte` | writing + phonology config | writing, config, vcs | revision string + window focus | partial |
| `WritingSystemView.svelte` | writing + phonology config, outlines | writing, config, vcs | revision string + focus + reload guard | partial |
| `Settings.svelte` (open) | language, grammar, roles, phonology, morphology | config, translation, dictionary | nothing while open | stale while open |
| `Inspector.svelte` | phonology copy, known tags | config, dictionary | `phonologyRevision`; tags on `ui.root` | partial (draft guards are by design) |
| `translation/FeatureEditor.svelte` | per-column feature values | dictionary, config | mount only | stale |
| `Grid.svelte` / `TablesPanel` / quarantine | table data via `doc.table` | dictionary | the dictionary branch | fresh |
| shared slices: `tree`, `wordIndex`, `tables`, `fixesTables` | workspace-derived indexes | notes, dictionary, config, workspace | the listener branches | fresh (a trash-renamed fixes table waits for the next config/workspace event) |
| `GitPanel.svelte` | vcs state, log, status | vcs, workspace | `vcsRevision` | fresh |
| Editor / open notes | note buffers | notes, vcs | `reloadOpenNotes` + freshness generations | fresh |

Backend emit gaps the audit flagged: `vcs_checkout`/`vcs_revert_file` never
emit `config` (all config-derived views go stale after a checkout), `undo`/
`redo` omit `notes` when the step rewrote note files, `save_note` emits
nothing (an open note in a second window goes stale), and the pref commands
(`set_keybind`, `set_editor_line_numbers`, `ui_layout_set`, `tiling_save`,
`grid_view_set`, `recent_record`) emit nothing by design — single-window,
self-contained consumers.

## Overlays

Overlays are driven by `ui` fields and rendered by their own component:
`contextMenu` (`ContextMenu.svelte`), `confirm` (`ConfirmDialog.svelte`), `toast`
(`Toast.svelte`), `paletteOpen` (`CommandPalette.svelte`), `settingsOpen`,
`setupWizardOpen`, `trashOpen`, `importOpen`. See `UI-CONVENTIONS.md` for the
shared dismissal contract.
