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
  format: TagFormat;
}

export type TagFormat = "default" | "multiline" | "date" | "measurement";

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

export interface DerivationNode extends RelatedWord {
  parents: string[];
}

export interface SortSpec {
  id: string;
  desc: boolean;
}

export interface GridViewState {
  sorting: SortSpec[];
  search: string;
  column_filters: Record<string, string>;
  hidden_columns: string[];
}

export interface TagKindChange {
  tag: string;
  from: FieldType;
  to: FieldType;
  affected: number;
  dropped: number;
}

export const wordIndex = (): Promise<WordIndex> => invoke("word_index");
export const listTables = (): Promise<TableSummary[]> => invoke("list_tables");
export const getTable = (table: string): Promise<WordTable> =>
  invoke("get_table", { table });
export const createTable = (name: string): Promise<boolean> =>
  invoke("create_table", { name });
export const deleteTable = (name: string): Promise<boolean> =>
  invoke("delete_table", { name });
export const renameTable = (from: string, to: string): Promise<boolean> =>
  invoke("rename_table", { from, to });
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
export const setTagKind = (
  table: string,
  tag: string,
  kind: FieldType,
): Promise<TagKindChange | null> =>
  invoke("set_tag_kind", { table, tag, kind });
export const setTagFormat = (
  table: string,
  tag: string,
  format: TagFormat,
): Promise<boolean> => invoke("set_tag_format", { table, tag, format });
export interface HistoryStatus {
  can_undo: boolean;
  can_redo: boolean;
}
export const historyStatus = (): Promise<HistoryStatus> =>
  invoke("history_status");
export const undo = (): Promise<boolean> => invoke("undo");
export const redo = (): Promise<boolean> => invoke("redo");
export const warningDismissed = (key: string): Promise<boolean> =>
  invoke("warning_dismissed", { key });
export const dismissWarning = (key: string): Promise<void> =>
  invoke("dismiss_warning", { key });
export const knownTagNames = (): Promise<string[]> =>
  invoke("known_tag_names");
export const gridViewGet = (table: string): Promise<GridViewState> =>
  invoke("grid_view_get", { table });
export const gridViewSet = (
  table: string,
  view: GridViewState,
): Promise<void> => invoke("grid_view_set", { table, view });
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
export const reparentWord = (
  table: string,
  child: string,
  parent: string,
): Promise<boolean> => invoke("reparent_word", { table, child, parent });
export const parentCandidates = (child: string): Promise<RelatedWord[]> =>
  invoke("parent_candidates", { child });
export const derivationTree = (id: string): Promise<DerivationTree> =>
  invoke("derivation_tree", { id });
export const derivationGraph = (id: string): Promise<DerivationNode[]> =>
  invoke("derivation_graph", { id });

// -- translation ---------------------------------------------------------
export type ClauseSlot =
  | { kind: "required_tag"; tag: string }
  | { kind: "literal"; text: string }
  | { kind: "wildcard" }
  | { kind: "spacer"; text?: string | null };

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
  | { kind: "separator"; value: string | null }
  | { kind: "placeholder"; value: string };

export type AffixKind = "prefix" | "suffix";

export interface AffixRule {
  kind: AffixKind;
  english: string;
  conlang: string;
}

export interface TranslationOptions {
  separator: string;
  affixes: AffixRule[];
}

export interface SlotOutcome {
  index: number;
  slot: ClauseSlot;
  symbol: Symbol;
}

export interface GlossMorpheme {
  surface: string;
  gloss: string;
}

export interface InterlinearGloss {
  morphemes: GlossMorpheme[];
  translation: string;
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
  gloss: InterlinearGloss;
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
export const translationOptions = (): Promise<TranslationOptions> =>
  invoke("translation_options");
export const setTranslationOptions = (
  options: TranslationOptions,
): Promise<void> => invoke("set_translation_options", { options });
export const exportPresets = (
  path: string,
  grids: SyntaxGrid[],
): Promise<void> => invoke("export_presets", { path, grids });
export const importPresets = (path: string): Promise<SyntaxGrid[]> =>
  invoke("import_presets", { path });

// -- config & layout -----------------------------------------------------
export type TextDirection = "ltr" | "rtl";

export interface LanguageConfig {
  name: string;
  author: string;
  description: string;
  script: string;
  direction: TextDirection;
}

export interface GrammarRule {
  name: string;
  description: string;
  slots: ClauseSlot[];
}

export interface GrammarConfig {
  rules: GrammarRule[];
}

export interface WindowLayout {
  width: number;
  height: number;
  git_panel_open: boolean;
}

export const configGet = <T>(section: string): Promise<T> =>
  invoke("config_get", { section });
export const configSet = <T>(
  section: string,
  value: T,
): Promise<void> => invoke("config_set", { section, value });
export const languageGet = (): Promise<LanguageConfig> =>
  configGet<LanguageConfig>("language");
export const languageSet = (value: LanguageConfig): Promise<void> =>
  configSet("language", value);
export const grammarGet = (): Promise<GrammarConfig> =>
  configGet<GrammarConfig>("grammar");
export const grammarSet = (value: GrammarConfig): Promise<void> =>
  configSet("grammar", value);
export const layoutGet = (): Promise<WindowLayout> =>
  invoke("layout_get");
export const layoutSetGitPanel = (open: boolean): Promise<void> =>
  invoke("layout_set_git_panel", { open });

export interface UiLayout {
  activity: string;
  sidebar_open: boolean;
  inspector_open: boolean;
  inspector_dock: string;
}

export const uiLayoutGet = (): Promise<UiLayout> => invoke("ui_layout_get");
export const uiLayoutSet = (layout: UiLayout): Promise<void> =>
  invoke("ui_layout_set", { layout });

// -- version control -----------------------------------------------------
export interface StatusEntry {
  code: string;
  path: string;
}export interface Commit {
  id: string;
  author: string;
  date: string;
  summary: string;
}

export interface VcsInfo {
  /** `ready`, `not_a_repo`, or `git_missing`. */
  state: string;
  branch: string | null;
}

export interface AutoCheckinInfo {
  enabled: boolean;
  secs: number;
}

export const vcsState = (): Promise<VcsInfo> => invoke("vcs_state");
export const vcsStatus = (): Promise<StatusEntry[]> => invoke("vcs_status");
export const vcsLog = (limit: number): Promise<Commit[]> =>
  invoke("vcs_log", { limit });
export const vcsDiff = (path: string | null): Promise<string> =>
  invoke("vcs_diff", { path });
export const vcsShow = (id: string): Promise<string> =>
  invoke("vcs_show", { id });
export const vcsBranches = (): Promise<string[]> => invoke("vcs_branches");
export const vcsCheckout = (name: string): Promise<void> =>
  invoke("vcs_checkout", { name });
export const vcsCreateBranch = (name: string): Promise<void> =>
  invoke("vcs_create_branch", { name });
export const gitPromptDismissed = (): Promise<boolean> =>
  invoke("git_prompt_dismissed");
export const setGitPromptDismissed = (dismissed: boolean): Promise<void> =>
  invoke("git_prompt_dismissed_set", { dismissed });
export const vcsCommit = (message: string): Promise<string | null> =>
  invoke("vcs_commit", { message });
export const vcsInit = (): Promise<void> => invoke("vcs_init");
export const vcsRevertFile = (path: string): Promise<void> =>
  invoke("vcs_revert_file", { path });
export const autocheckinGet = (): Promise<AutoCheckinInfo> =>
  invoke("autocheckin_get");
export const autocheckinSet = (
  enabled: boolean,
  secs: number,
): Promise<void> => invoke("autocheckin_set", { enabled, secs });
export const autocheckinPump = (): Promise<string | null> =>
  invoke("autocheckin_pump");

