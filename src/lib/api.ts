import { invoke } from "@tauri-apps/api/core";

/** A registered workspace (mirrors `nueon_core::WorkspaceEntry`). */
export interface WorkspaceEntry {
  name: string;
  path: string;
}

/** A node in the notes tree (mirrors `nueon_tauri`'s `NoteNode`). */
export interface NoteNode {
  name: string;
  /** Path relative to `notes/`, using `/` separators. */
  path: string;
  is_dir: boolean;
  children: NoteNode[];
}

/** A dictionary entry matching a spelling (mirrors `nueon_core::WordHit`). */
export interface WordHit {
  id: string;
  table: string;
  wordname: string;
  senses: string[];
  tags: string[];
}

/** Lowercased wordname → matching entries. */
export type WordIndex = Record<string, WordHit[]>;

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

// -- notes ---------------------------------------------------------------
export const listWorkspace = (): Promise<NoteNode[]> =>
  invoke("list_workspace");
/** A note's text and the hash later saves are checked against. */
export interface NoteSnapshot {
  content: string;
  hash: string;
}

export const readNote = (relPath: string): Promise<NoteSnapshot> =>
  invoke("read_note", { relPath });
/**
 * Save an existing note. Never creates a file, and rejects with a
 * `conflict:` error when the note changed on disk since `baseHash`.
 * Resolves to the new content hash.
 */
export const saveNote = (
  relPath: string,
  content: string,
  baseHash: string | null,
): Promise<string> => invoke("save_note", { relPath, content, baseHash });
/** Create a new note with content; never overwrites. Resolves to its path. */
export const createNoteWithContent = (
  relPath: string,
  content: string,
): Promise<string> => invoke("create_note_with_content", { relPath, content });
/** Create a note; resolves to its final path (`.md` is appended if missing). */
export const createNote = (relPath: string): Promise<string> =>
  invoke("create_note", { relPath });
export const createFolder = (relPath: string): Promise<void> =>
  invoke("create_folder", { relPath });
/** Move/rename; resolves to the final path (files keep their extension). */
export const moveOrRenameNote = (
  oldPath: string,
  newPath: string,
): Promise<string> => invoke("move_or_rename_note", { oldPath, newPath });
/** Move a note or folder to the trash. Resolves to the trash record. */
export const deleteNote = (relPath: string): Promise<TrashRecord> =>
  invoke("delete_note", { relPath });
/** Number of files a note path covers (for the delete confirmation). */
export const noteCount = (relPath: string): Promise<number> =>
  invoke("note_count", { relPath });

// -- trash ---------------------------------------------------------------
export type TrashKind = "note" | "folder" | "table";

export interface TrashRecord {
  /** Entry directory name; the handle for restore/purge. */
  id: string;
  kind: TrashKind;
  original: string;
  name: string;
  deleted_at: number;
  count: number;
}

export interface Restored {
  kind: TrashKind;
  /** Notes/folders: the restored path. Tables: the restored name. */
  name: string;
}

export const trashList = (): Promise<TrashRecord[]> => invoke("trash_list");
export const trashRestore = (id: string): Promise<Restored> =>
  invoke("trash_restore", { id });
export const trashPurge = (id: string): Promise<void> =>
  invoke("trash_purge", { id });
export const trashEmpty = (): Promise<number> => invoke("trash_empty");

// -- export --------------------------------------------------------------
export type ExportFormat = "pdf" | "odt";

/** Export the note's current text; resolves to a status message. */
export const exportDocument = (
  format: ExportFormat,
  notePath: string,
  markdown: string,
  destination: string,
): Promise<string> =>
  invoke("export_document", { format, notePath, markdown, destination });

// -- assets --------------------------------------------------------------
export type AssetKind = "image" | "text" | "other";

export interface ImportedAsset {
  name: string;
  /** Path relative to `notes/` (`assets/My-Photo.png`). */
  relative: string;
  kind: AssetKind;
  original_name: string;
  existed: boolean;
}

export const importAsset = (path: string): Promise<ImportedAsset> =>
  invoke("import_asset", { path });
/** Copy a dropped file into a notes folder, keeping its own name. Returns the
 * path relative to `notes/`. */
export const copyIntoNotes = (folder: string, path: string): Promise<string> =>
  invoke("copy_into_notes", { folder, path });

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
  suggest?: boolean;
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

export interface DerivationNode extends RelatedWord {
  parents: string[];
}

export interface SortSpec {
  id: string;
  desc: boolean;
}

/**
 * Presentation state for one table's grid.
 *
 * Every field is optional: the backend skips empty values when serializing,
 * so a view with nothing hidden, searched, reordered or resized arrives as
 * `{}`. Callers must default each field rather than assume it is present.
 */
export interface GridViewState {
  sorting?: SortSpec[];
  search?: string;
  column_filters?: Record<string, string>;
  hidden_columns?: string[];
  /** Column ids in display order; empty means the default order. */
  column_order?: string[];
  /** User-adjusted column widths in pixels, keyed by column id. */
  column_widths?: Record<string, number>;
}

// -- tiling layout -------------------------------------------------------
export interface TabLayout {
  kind: "note" | "file" | "table" | "translation" | "phonology";
  ref?: string | null;
  title: string;
}

export interface GroupLayout {
  id: string;
  tabs: TabLayout[];
  active?: number | null;
}

export type SplitLayout =
  | { type: "leaf"; group: string }
  | {
      type: "split";
      direction: "row" | "column";
      children: SplitLayout[];
      sizes?: number[];
    };

export interface TilingLayout {
  groups: GroupLayout[];
  root: SplitLayout;
  active_group?: string | null;
}

export interface WindowGeometry {
  x?: number | null;
  y?: number | null;
  width: number;
  height: number;
}

export interface SecondaryWindow {
  label: string;
  geometry?: WindowGeometry | null;
  tiling: TilingLayout;
}

export interface LayoutState {
  main?: TilingLayout | null;
  windows?: SecondaryWindow[];
}

export const windowSpawn = (
  tab: TabLayout,
  geometry?: WindowGeometry | null,
): Promise<string> => invoke("window_spawn", { tab, geometry: geometry ?? null });
export const windowCloseSelf = (): Promise<void> => invoke("window_close_self");
export const windowsRestore = (): Promise<number> => invoke("windows_restore");
export const layoutStateGet = (): Promise<LayoutState> =>
  invoke("layout_state_get");
export const tilingSave = (
  label: string,
  tiling: TilingLayout,
): Promise<void> => invoke("tiling_save", { label, tiling });

export interface TagKindChange {
  tag: string;
  from: FieldType;
  to: FieldType;
  affected: number;
  dropped: number;
}

export const wordIndex = (): Promise<WordIndex> => invoke("word_index");
export const listTables = (): Promise<TableSummary[]> => invoke("list_tables");

/** A file under `dictionary/` that exists but could not be loaded as a table. */
export interface QuarantineWarning {
  file_name: string;
  reason: string;
}
export const quarantineWarnings = (): Promise<QuarantineWarning[]> =>
  invoke("quarantine_warnings");
/**
 * The backend omits empty `values` maps when serializing entries, so every
 * consumer would otherwise have to guard `entry.values`. Normalize once here.
 */
function normalizeTable(table: WordTable): WordTable {
  return {
    ...table,
    tags: table.tags ?? [],
    entries: (table.entries ?? []).map((entry) => ({
      ...entry,
      values: entry.values ?? {},
    })),
  };
}

export const getTable = (table: string): Promise<WordTable> =>
  invoke<WordTable>("get_table", { table }).then(normalizeTable);
export const createTable = (name: string): Promise<boolean> =>
  invoke("create_table", { name });
/** Move a table to the trash. Resolves to the record, or null if absent. */
export const deleteTable = (name: string): Promise<TrashRecord | null> =>
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
/**
 * Apply one field's value to a word, against whatever is currently stored —
 * never a snapshot the caller might be holding stale. `value: null` removes
 * the tag. Prefer this (and `setWordDefinition`/`renameWord`) over
 * `saveWordEntry` for editing a field of an *existing* word: sending the
 * whole entry can silently clobber a concurrent edit to a different field.
 */
export const setWordValue = (
  table: string,
  id: string,
  tag: string,
  value: FieldValue | null,
): Promise<boolean> => invoke("set_word_value", { table, id, tag, value });
export const setWordsValue = (
  table: string,
  ids: string[],
  tag: string,
  value: FieldValue | null,
): Promise<number> => invoke("set_words_value", { table, ids, tag, value });
export const setWordDefinition = (
  table: string,
  id: string,
  senses: string[],
): Promise<boolean> =>
  invoke("set_word_definition", { table, id, senses });
export const renameWord = (
  table: string,
  id: string,
  wordname: string,
): Promise<boolean> => invoke("rename_word", { table, id, wordname });
export const deleteWord = (table: string, id: string): Promise<boolean> =>
  invoke("delete_word", { table, id });
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
export const setTagSuggest = (
  table: string,
  tag: string,
  suggest: boolean,
): Promise<boolean> => invoke("set_tag_suggest", { table, tag, suggest });
export const undo = (): Promise<boolean> => invoke("undo");
export const redo = (): Promise<boolean> => invoke("redo");
export const warningDismissed = (key: string): Promise<boolean> =>
  invoke("warning_dismissed", { key });
export const dismissWarning = (key: string): Promise<void> =>
  invoke("dismiss_warning", { key });
export const suppressedConfirms = (): Promise<string[]> =>
  invoke("suppressed_confirms");
export const suppressConfirm = (kind: string): Promise<void> =>
  invoke("suppress_confirm", { kind });
export const clearSuppressedConfirms = (): Promise<void> =>
  invoke("clear_suppressed_confirms");
export const editorLineNumbers = (): Promise<boolean> =>
  invoke("editor_line_numbers");
export const setEditorLineNumbers = (show: boolean): Promise<void> =>
  invoke("set_editor_line_numbers", { show });
export const keybindsGet = (): Promise<Record<string, string>> =>
  invoke("keybinds_get");
export const setKeybind = (id: string, key: string | null): Promise<void> =>
  invoke("set_keybind", { id, key });
export const resetKeybinds = (): Promise<void> => invoke("reset_keybinds");
export const exportWorkspaceZip = (path: string): Promise<void> =>
  invoke("export_workspace_zip", { path });
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
export const derivationGraph = (id: string): Promise<DerivationNode[]> =>
  invoke("derivation_graph", { id });

// -- translation ---------------------------------------------------------
export type ClauseSlot =
  | { kind: "required_tag"; tag: string }
  | { kind: "pos"; class: string }
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

export type TranslationMode = "grid" | "direct";

export interface TranslationOptions {
  separator: string;
  affixes: AffixRule[];
  mode: TranslationMode;
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
  /** Token index (as a string key) → the entries it could resolve to. */
  candidates: Record<string, WordHit[]>;
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
  selections: FeatureSelections,
): Promise<TranslationReport> =>
  invoke("execute_translation", { inputText, grid, choices, selections });
/** Word-for-word mode: no syntax grid. */
export const executeTranslationDirect = (
  inputText: string,
  choices: Record<string, string>,
  selections: FeatureSelections,
): Promise<TranslationReport> =>
  invoke("execute_translation_direct", { inputText, choices, selections });
/** Existing entries whose name/senses match a token (search-as-you-type). */
export const translationSuggest = (token: string): Promise<WordHit[]> =>
  invoke("translation_suggest", { token });
export const createTranslationWord = (
  table: string,
  wordname: string,
  definition: string,
  tags: string[],
  pos?: string | null,
): Promise<string | null> =>
  invoke("create_translation_word", { table, wordname, definition, tags, pos });
export type TableRole = "vocab" | "fixes";
export interface TableRoleConfig {
  role: TableRole;
  trigger?: string | null;
  surface?: string | null;
}
export const tableRolesGet = (): Promise<Record<string, TableRoleConfig>> =>
  invoke("table_roles_get");
export const setTableRole = (
  table: string,
  role: TableRole,
  trigger: string | null,
  surface: string | null,
): Promise<boolean> =>
  invoke("set_table_role", { table, role, trigger, surface });
export const translationOptions = (): Promise<TranslationOptions> =>
  invoke("translation_options");
export const setTranslationOptions = (
  options: TranslationOptions,
): Promise<void> => invoke("set_translation_options", { options });
export const exportPresets = (
  path: string,
  grids: SyntaxGrid[],
): Promise<void> => invoke("export_presets", { path, grids });
export const profileExport = (path: string): Promise<void> =>
  invoke("profile_export", { path });
export const profileImport = (path: string): Promise<void> =>
  invoke("profile_import", { path });
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

export const configGet = <T>(section: string): Promise<T> =>
  invoke("config_get", { section });

/**
 * Config sections the UI may replace. `settings` is deliberately absent: that
 * file also holds grid views, layout and migration flags, and the backend
 * refuses to overwrite it wholesale.
 */
export type WritableConfigSection =
  | "language"
  | "grammar"
  | "translation"
  | "phonology";
export const configSet = <T>(
  section: WritableConfigSection,
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

export interface TranslationConfig {
  default_rule?: string | null;
  settings: Record<string, string>;
  grids: SyntaxGrid[];
  affixes: AffixRule[];
  morphology?: Morphology;
  table_roles?: Record<string, TableRoleConfig>;
}

export const translationConfig = (): Promise<TranslationConfig> =>
  configGet<TranslationConfig>("translation");

export interface FeatureValue {
  id: string;
  label: string;
}
export interface Feature {
  id: string;
  label: string;
  values: FeatureValue[];
}
export interface ParadigmRow {
  when: Record<string, string>;
  surface: string;
  kind: AffixKind;
}
export interface Paradigm {
  class: string;
  rows: ParadigmRow[];
}
export interface Morphology {
  features: Feature[];
  paradigms: Paradigm[];
}
/** The selected feature values for one clause, e.g. `{ tense: "past" }`. */
export type FeatureSelections = Record<string, string>;

export const translationMorphology = (): Promise<Morphology> =>
  invoke("translation_morphology");
export const setTranslationMorphology = (
  morphology: Morphology,
): Promise<void> => invoke("set_translation_morphology", { morphology });

export type PhonemeKind = "consonant" | "vowel" | "other";

export interface Phoneme {
  symbol: string;
  kind: PhonemeKind;
}

export interface PhonologyConfig {
  phonemes: Phoneme[];
  syllables: string[];
}

export const phonologyGet = (): Promise<PhonologyConfig> =>
  configGet<PhonologyConfig>("phonology");
export const phonologySet = (value: PhonologyConfig): Promise<void> =>
  configSet("phonology", value);

export type PhonologyViolation =
  | { kind: "unknown_phoneme"; at: number; symbol: string }
  | { kind: "bad_syllable"; at: number };

/** Batched phonotactic check; one list of violations per input word. */
export const phonologyCheckWords = (
  words: string[],
): Promise<PhonologyViolation[][]> =>
  invoke("phonology_check_words", { words });

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

// -- import --------------------------------------------------------------
/** What a column in an imported file means (mirrors `ColumnRole`). */
export type ColumnRole =
  | { role: "ignore" }
  | { role: "wordname" }
  | { role: "definition" }
  | { role: "parents" }
  | { role: "references"; name: string }
  | { role: "tag_flags" }
  | { role: "text_tag"; name: string }
  | { role: "list_tag"; name: string }
  | { role: "boolean_tag"; name: string };

export type DuplicatePolicy = "skip" | "update" | "add";
export type LinkSyntax = "wiki" | "none";

/** Mirrors `ImportOptions`. Char fields are single-character strings. */
export interface ImportOptions {
  delimiter: string;
  quote: string;
  has_header: boolean;
  tag_list_delimiter: string;
  tag_prefix: string;
  parent_delimiter: string;
  link_syntax: LinkSyntax;
  roles: ColumnRole[];
  target_table: string;
  duplicate_policy: DuplicatePolicy;
  skip_placeholders: boolean;
  create_suffix_entries: boolean;
}

export interface ColumnProposal {
  index: number;
  header: string;
  role: ColumnRole;
  distinct_values: number;
  boolean_split: string[];
  reasons: string[];
}

export interface Detection {
  delimiter: string;
  has_header: boolean;
  columns: ColumnProposal[];
}

export interface TagProposal {
  name: string;
  kind: FieldType;
}

export interface LinkReport {
  occurrences: number;
  unique_targets: number;
  exact: string[];
  case_only: [string, string][];
  unresolved: string[];
  ambiguous: string[];
}

export interface DuplicateConflict {
  wordname: string;
  incoming_table: string;
  existing_tables: string[];
}

export interface SuspiciousRow {
  row: number;
  wordname: string;
  reason: string;
}

export interface Preview {
  table: string;
  rows_total: number;
  rows_blank: number;
  short_rows: number[];
  placeholders: number[];
  rows_skipped: number;
  words: number;
  tags: TagProposal[];
  links: LinkReport;
  duplicates: DuplicateConflict[];
  suspicious: SuspiciousRow[];
  non_nfc_rows: number[];
  warnings: string[];
}

export type LinkChoice =
  | { choice: "use_existing"; table: string; id: string }
  | { choice: "create_suffix" }
  | { choice: "leave" };

export interface ImportPlan {
  source: string;
  options: ImportOptions;
  link_choices: Record<string, LinkChoice>;
  duplicate_choices: Record<string, DuplicatePolicy>;
}

export interface ImportReport {
  table: string;
  words_created: number;
  words_updated: number;
  words_skipped: number;
  tags_created: string[];
  parents_linked: number;
  parents_skipped: number;
  references_linked: number;
  references_skipped: number;
  suffix_entries: number;
  warnings: string[];
}

export const importDetect = (
  path: string,
  options: ImportOptions,
): Promise<Detection> => invoke("import_detect", { path, options });
export const importPreview = (
  path: string,
  options: ImportOptions,
): Promise<Preview> => invoke("import_preview", { path, options });
export const importApply = (plan: ImportPlan): Promise<ImportReport> =>
  invoke("import_apply", { plan });

// -- table export --------------------------------------------------------
export type TableFormat = "csv" | "tsv" | "json";

/** Export a table to `destination`; resolves to the written path. */
export const exportTable = (
  name: string,
  format: TableFormat,
  destination: string,
): Promise<string> => invoke("export_table", { name, format, destination });
