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

## Overlays

Overlays are driven by `ui` fields and rendered by their own component:
`contextMenu` (`ContextMenu.svelte`), `confirm` (`ConfirmDialog.svelte`), `toast`
(`Toast.svelte`), `paletteOpen` (`CommandPalette.svelte`), `settingsOpen`,
`setupWizardOpen`, `trashOpen`, `importOpen`. See `UI-CONVENTIONS.md` for the
shared dismissal contract.
