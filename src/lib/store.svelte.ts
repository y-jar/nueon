/**
 * The global reactive `ui` store, its document/tab types and the group
 * helpers that only touch it. Kept separate so the tab/layout/notes action
 * modules can all share one source of truth.
 */

import * as api from "./api";
import type { SplitNode } from "./tiling";

/** Left activity ribbon selection. */
export type Activity =
  | "notes"
  | "dictionary"
  | "translation"
  | "morphology"
  | "phonology"
  | "git";

/** The kind of document a center tab represents. */
export type TabKind =
  | "note"
  | "file"
  | "table"
  | "translation"
  | "morphology"
  | "phonology";

/** A center workspace tab. */
export interface Tab {
  id: string;
  kind: TabKind;
  /** Note path or table name; `null` for the translation tool. */
  ref: string | null;
  title: string;
}

/** Which panel a group's center pane is rendering. */
export type View =
  | "notes"
  | "file"
  | "dictionary"
  | "translation"
  | "morphology"
  | "phonology";

/** The loaded document for one tab group. */
export interface DocState {
  view: View;
  selected: string | null;
  noteContent: string;
  /** Hash of `noteContent` as read from disk; saves are checked against it. */
  noteHash: string | null;
  dirty: boolean;
  /** The open note changed on disk (or vanished) while it has unsaved edits. */
  conflict: "changed" | "missing" | null;
  currentTable: string | null;
  table: api.WordTable | null;
  selectedEntry: string | null;
}

/** A pane of tabs. Split view composes several of these. */
export interface TabGroup {
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
  doc: DocState;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function emptyDoc(): DocState {
  return {
    view: "notes",
    selected: null,
    noteContent: "",
    noteHash: null,
    dirty: false,
    conflict: null,
    currentTable: null,
    table: null,
    selectedEntry: null,
  };
}

export function makeGroup(): TabGroup {
  return { id: newId(), tabs: [], activeTabId: null, doc: emptyDoc() };
}

const firstGroup = makeGroup();

/** A pending yes/no question shown as a modal dialog. */
export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  /** When set, the dialog offers a "don't ask again" that silences this kind. */
  kind?: string;
  /** When set, the user must type this exact text to enable Confirm. */
  requireText?: string;
  resolve: (confirmed: boolean) => void;
}

/** A column header right-click menu, with the actions Grid owns. */
export interface ColumnMenuPayload {
  id: string;
  canHide: boolean;
  /** A user tag column (not wordname/parent/definition): type/deletion allowed. */
  isTag: boolean;
  kind: api.FieldType | null;
  onHide: () => void;
  onSortAsc: () => void;
  onSortDesc: () => void;
  onClearSort: () => void;
  onChangeKind?: (kind: api.FieldType) => void;
  onDelete?: () => void;
}

/** A transient message, optionally with one action (Undo). */
export interface ToastState {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** Global reactive UI state (Svelte 5 runes). */
export const ui = $state({
  workspaces: [] as api.WorkspaceEntry[],
  root: null as string | null,

  // Shell chrome.
  activity: "notes" as Activity,
  sidebarOpen: true,
  inspectorOpen: false,
  inspectorDock: "right" as "left" | "right",
  settingsOpen: false,
  setupWizardOpen: false,
  /** Confirm-dialog kinds the user has silenced ("don't ask again"). */
  suppressedConfirms: [] as string[],
  /** Whether the Markdown editor shows line numbers (workspace preference). */
  showLineNumbers: true,
  /** Keybind overrides (command id → CodeMirror combo); missing = default. */
  keybinds: {} as Record<string, string>,
  confirm: null as ConfirmRequest | null,
  toast: null as ToastState | null,
  trashOpen: false,
  importOpen: false,
  /** The command palette overlay. */
  paletteOpen: false,
  /** Show the workspace picker/onboarding over an open workspace. */
  showWorkspacePicker: false,

  // Tiling layout.
  groups: [firstGroup] as TabGroup[],
  activeGroupId: firstGroup.id as string,
  splitRoot: { type: "leaf", groupId: firstGroup.id } as SplitNode,
  /** True once the saved layout is restored; gates layout persistence. */
  layoutReady: false,

  // Workspace data shared across groups.
  tree: [] as api.NoteNode[],
  status: "",
  tables: [] as api.TableSummary[],
  quarantine: [] as api.QuarantineWarning[],
  /** Quarantine file names dismissed for this session only. */
  quarantineDismissed: [] as string[],
  wordIndex: {} as api.WordIndex,
  nameById: {} as Record<string, string>,
  /** Note path → ATX headings, cached lazily for `[[note#heading]]`. */
  noteHeadings: {} as Record<string, string[]>,
  /** Pending "scroll to this heading" request after following a link. */
  scrollToHeading: null as { path: string; heading: string } | null,
  vcsRevision: 0,
  /** Bumped when the phonology config is written elsewhere (Settings). */
  phonologyRevision: 0,
  /** Bumped when the morphology config is written elsewhere (Morphology). */
  morphologyRevision: 0,
  /** The table last used by the Morphology "Save as word" form (session). */
  morphologySaveTable: "",

  // Notes drag/context-menu plumbing.
  dragPath: null as string | null,
  contextMenu: null as {
    x: number;
    y: number;
    path: string;
    isDir: boolean;
    kind: "node" | "root" | "tab" | "editor" | "column" | "table";
    tab?: { groupId: string; tabId: string };
    column?: ColumnMenuPayload;
    table?: string;
  } | null,
  renameTarget: null as string | null,
  /** A table the Tables panel should flip into inline-rename mode. */
  tableRenameTarget: null as string | null,
  newRequest: null as { kind: "note" | "folder"; base: string } | null,
  collapseAllSignal: 0,
  /** Tab currently being dragged (native DnD), if any. */
  dragTab: null as { tabId: string; fromGroupId: string } | null,
});

// -- group helpers -------------------------------------------------------

export function activeGroup(): TabGroup {
  return (
    ui.groups.find((group) => group.id === ui.activeGroupId) ?? ui.groups[0]
  );
}

export function activeDoc(): DocState {
  return activeGroup().doc;
}

export function setActiveGroup(groupId: string): void {
  if (ui.groups.some((group) => group.id === groupId)) {
    ui.activeGroupId = groupId;
  }
}

export function clearDoc(doc: DocState): void {
  doc.view = "notes";
  doc.selected = null;
  doc.noteContent = "";
  doc.noteHash = null;
  doc.dirty = false;
  doc.conflict = null;
  doc.currentTable = null;
  doc.table = null;
  doc.selectedEntry = null;
}
