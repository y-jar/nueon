import { invoke } from "@tauri-apps/api/core";

/** A registered workspace (mirrors `langloom_core::WorkspaceEntry`). */
export interface WorkspaceEntry {
  name: string;
  path: string;
}

/** A node in the notes tree (mirrors `langloom_tauri`'s `NoteNode`). */
export interface NoteNode {
  name: string;
  /** Path relative to `notes/`, using `/` separators. */
  path: string;
  is_dir: boolean;
  children: NoteNode[];
}

/** A dictionary entry matching a spelling (mirrors `langloom_core::WordHit`). */
export interface WordHit {
  id: string;
  table: string;
  wordname: string;
  senses: string[];
  tags: string[];
}

/** Lowercased wordname → matching entries. */
export type WordIndex = Record<string, WordHit[]>;

export const ping = (): Promise<string> => invoke("ping");

// -- workspace registry --------------------------------------------------
export const workspaceList = (): Promise<WorkspaceEntry[]> =>
  invoke("workspace_list");
export const workspaceCurrent = (): Promise<string | null> =>
  invoke("workspace_current");
export const workspaceOpen = (path: string): Promise<string> =>
  invoke("workspace_open", { path });
export const workspaceCreate = (
  name: string,
  destination: string,
): Promise<string> => invoke("workspace_create", { name, destination });
export const workspaceRemove = (path: string): Promise<void> =>
  invoke("workspace_remove", { path });
export const workspaceRename = (path: string, name: string): Promise<void> =>
  invoke("workspace_rename", { path, name });
export const workspaceSetPath = (from: string, to: string): Promise<void> =>
  invoke("workspace_set_path", { from, to });
export const workspaceDeleteFromDisk = (path: string): Promise<void> =>
  invoke("workspace_delete_from_disk", { path });

// -- notes ---------------------------------------------------------------
export const listWorkspace = (): Promise<NoteNode[]> =>
  invoke("list_workspace");
export const readNote = (relPath: string): Promise<string> =>
  invoke("read_note", { relPath });
export const saveNote = (relPath: string, content: string): Promise<void> =>
  invoke("save_note", { relPath, content });
export const createNote = (relPath: string): Promise<void> =>
  invoke("create_note", { relPath });
export const createFolder = (relPath: string): Promise<void> =>
  invoke("create_folder", { relPath });
export const moveOrRenameNote = (
  oldPath: string,
  newPath: string,
): Promise<void> => invoke("move_or_rename_note", { oldPath, newPath });
export const deleteNote = (relPath: string): Promise<void> =>
  invoke("delete_note", { relPath });

// -- dictionary ----------------------------------------------------------
export type FieldType =
  | "text"
  | "boolean"
  | "tag_list"
  | "reference"
  | "references";

export type FieldValue =
  | { type: "text"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "tag_list"; value: string[] }
  | { type: "reference"; value: string }
  | { type: "references"; value: string[] };

export interface TagDef {
  name: string;
  description: string;
  color?: string | null;
  kind: FieldType;
  builtin: boolean;
}

export interface WordEntry {
  id: string;
  wordname: string;
  values: Record<string, FieldValue>;
}

export interface WordTable {
  name: string;
  tags: TagDef[];
  entries: WordEntry[];
}

export interface TableSummary {
  name: string;
  word_count: number;
  tags: TagDef[];
}

export interface RelatedWord {
  table: string;
  id: string;
  wordname: string;
}

export interface DerivationTree {
  ancestors: RelatedWord[];
  children: RelatedWord[];
  descendants: RelatedWord[];
}

export const wordIndex = (): Promise<WordIndex> => invoke("word_index");
export const listTables = (): Promise<TableSummary[]> => invoke("list_tables");
export const getTable = (table: string): Promise<WordTable> =>
  invoke("get_table", { table });
export const createTable = (name: string): Promise<boolean> =>
  invoke("create_table", { name });
export const deleteTable = (name: string): Promise<boolean> =>
  invoke("delete_table", { name });
export const createWord = (
  table: string,
  wordname: string,
): Promise<string | null> => invoke("create_word", { table, wordname });
export const saveWordEntry = (
  table: string,
  entry: WordEntry,
): Promise<boolean> => invoke("save_word_entry", { table, entry });
export const deleteWord = (table: string, id: string): Promise<boolean> =>
  invoke("delete_word", { table, id });
export const moveWord = (
  from: string,
  to: string,
  id: string,
): Promise<boolean> => invoke("move_word", { from, to, id });
export const addTag = (
  table: string,
  name: string,
  kind: FieldType,
): Promise<boolean> => invoke("add_tag", { table, name, kind });
export const removeTagPreview = (
  table: string,
  tag: string,
): Promise<number> => invoke("remove_tag_preview", { table, tag });
export const removeTag = (table: string, tag: string): Promise<boolean> =>
  invoke("remove_tag", { table, tag });
export const setParent = (
  table: string,
  child: string,
  parent: string,
): Promise<boolean> => invoke("set_parent", { table, child, parent });
export const removeParent = (
  table: string,
  child: string,
  parent: string,
): Promise<boolean> => invoke("remove_parent", { table, child, parent });
export const parentCandidates = (child: string): Promise<RelatedWord[]> =>
  invoke("parent_candidates", { child });
export const derivationTree = (id: string): Promise<DerivationTree> =>
  invoke("derivation_tree", { id });

// -- translation ---------------------------------------------------------
export type ClauseSlot =
  | { kind: "required_tag"; tag: string }
  | { kind: "literal"; text: string }
  | { kind: "wildcard" }
  | { kind: "spacer" };

export interface SyntaxGrid {
  preset_name: string;
  slots: ClauseSlot[];
}

export interface Token {
  text: string;
  normalized: string;
}

export type Symbol =
  | { kind: "word"; value: string }
  | { kind: "literal"; value: string }
  | { kind: "separator" }
  | { kind: "placeholder"; value: string };

export interface SlotOutcome {
  index: number;
  slot: ClauseSlot;
  symbol: Symbol;
}

export interface TranslationReport {
  output: string;
  complete: boolean;
  tokens: Token[];
  slots: SlotOutcome[];
  missing: number[];
  conflicts: number[];
  leftovers: [number, string][];
  unfilled: number[];
}

export const listPresets = (): Promise<SyntaxGrid[]> =>
  invoke("list_presets");
export const savePreset = (grid: SyntaxGrid): Promise<void> =>
  invoke("save_preset", { grid });
export const deletePreset = (name: string): Promise<boolean> =>
  invoke("delete_preset", { name });
export const executeTranslation = (
  inputText: string,
  grid: SyntaxGrid,
  choices: Record<string, string>,
): Promise<TranslationReport> =>
  invoke("execute_translation", { inputText, grid, choices });
export const createTranslationWord = (
  table: string,
  wordname: string,
  definition: string,
  tags: string[],
): Promise<string | null> =>
  invoke("create_translation_word", { table, wordname, definition, tags });

