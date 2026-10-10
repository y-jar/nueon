//! Keybinding definitions, formatting and reserved combos.
/**
 * The keybind registry: every remappable command with its stable id and
 * built-in key. Kept as plain data (no editor imports) so it can feed Settings
 * directly; `commands.ts`/`tableEditing.ts` turn it into CodeMirror keymaps.
 */

export interface KeybindDef {
  /** Stable command id, used as the override key. */
  id: string;
  /** Built-in CodeMirror key combo. */
  defaultKey: string;
  labelKey: string;
  values?: Record<string, string | number>;
}

export interface KeybindGroup {
  titleKey: string;
  bindings: KeybindDef[];
}

/** `Mod-Shift-l` → `Ctrl+Shift+L`. */
export function formatKeys(keys: string): string {
  const parts = keys.split("-").map((part) => (part === "Mod" ? "Ctrl" : part));
  const last = parts.length - 1;
  if (/^[a-z]$/.test(parts[last])) parts[last] = parts[last].toUpperCase();
  return parts.join("+");
}

export const MARKDOWN_KEYBINDS: KeybindDef[] = [
  { id: "bold", defaultKey: "Mod-b", labelKey: "keybinds.bold" },
  { id: "italic", defaultKey: "Mod-i", labelKey: "keybinds.italic" },
  { id: "underline", defaultKey: "Mod-u", labelKey: "keybinds.underline" },
  { id: "link", defaultKey: "Mod-k", labelKey: "keybinds.link" },
  { id: "bullet-list", defaultKey: "Mod-Shift-8", labelKey: "keybinds.bulletList" },
  { id: "numbered-list", defaultKey: "Mod-Shift-7", labelKey: "keybinds.numberedList" },
  { id: "blockquote", defaultKey: "Mod-Shift-9", labelKey: "keybinds.blockquote" },
  { id: "task-list", defaultKey: "Mod-Alt-l", labelKey: "keybinds.taskList" },
  { id: "word-link", defaultKey: "Mod-Shift-l", labelKey: "keybinds.wordLink" },
  { id: "table", defaultKey: "Mod-Shift-t", labelKey: "keybinds.table" },
  { id: "code-block", defaultKey: "Mod-Shift-c", labelKey: "keybinds.codeBlock" },
  { id: "heading-1", defaultKey: "Mod-1", labelKey: "keybinds.heading", values: { level: 1 } },
  { id: "heading-2", defaultKey: "Mod-2", labelKey: "keybinds.heading", values: { level: 2 } },
  { id: "heading-3", defaultKey: "Mod-3", labelKey: "keybinds.heading", values: { level: 3 } },
  { id: "heading-4", defaultKey: "Mod-4", labelKey: "keybinds.heading", values: { level: 4 } },
  { id: "heading-5", defaultKey: "Mod-5", labelKey: "keybinds.heading", values: { level: 5 } },
  { id: "heading-6", defaultKey: "Mod-6", labelKey: "keybinds.heading", values: { level: 6 } },
  { id: "clear-heading", defaultKey: "Mod-0", labelKey: "keybinds.clearHeading" },
  { id: "strikethrough", defaultKey: "Mod-Shift-x", labelKey: "keybinds.strikethrough" },
  { id: "image", defaultKey: "Mod-Shift-p", labelKey: "keybinds.image" },
];

export const TABLE_KEYBINDS: KeybindDef[] = [
  { id: "next-cell", defaultKey: "Tab", labelKey: "keybinds.nextCell" },
  { id: "prev-cell", defaultKey: "Shift-Tab", labelKey: "keybinds.prevCell" },
  { id: "next-row", defaultKey: "Enter", labelKey: "keybinds.nextRow" },
];

export const EDITING_KEYBINDS: KeybindDef[] = [
  { id: "save", defaultKey: "Mod-s", labelKey: "keybinds.save" },
];

export const KEYBIND_GROUPS: KeybindGroup[] = [
  { titleKey: "keybinds.groupMarkdown", bindings: MARKDOWN_KEYBINDS },
  { titleKey: "keybinds.groupTables", bindings: TABLE_KEYBINDS },
  { titleKey: "keybinds.groupEditing", bindings: EDITING_KEYBINDS },
];

/** Every def, by id — for labels and lookups. */
export const KEYBIND_BY_ID: Record<string, KeybindDef> = Object.fromEntries(
  KEYBIND_GROUPS.flatMap((group) => group.bindings).map((def) => [def.id, def]),
);

/** Built-in keys for every remappable command, by id. */
export function defaultKeybinds(): Record<string, string> {
  return Object.fromEntries(
    KEYBIND_GROUPS.flatMap((group) => group.bindings).map((def) => [
      def.id,
      def.defaultKey,
    ]),
  );
}

/**
 * Merge user overrides onto the defaults. A missing id uses its default; an
 * override of `""` unbinds the command (`null`).
 */
export function resolveKeybinds(
  overrides: Record<string, string>,
): Record<string, string | null> {
  const resolved: Record<string, string | null> = {};
  for (const [id, def] of Object.entries(KEYBIND_BY_ID)) {
    if (id in overrides) {
      const value = overrides[id];
      resolved[id] = value === "" ? null : value;
    } else {
      resolved[id] = def.defaultKey;
    }
  }
  return resolved;
}

/**
 * Combos reserved by the OS or the shell chrome; binding these would break
 * copy/paste/undo/close/reload, so the capture popup refuses them.
 */
export const RESERVED_COMBOS = new Set([
  "Mod-c",
  "Mod-v",
  "Mod-x",
  "Mod-a",
  "Mod-z",
  "Mod-Shift-z",
  "Mod-y",
  "Mod-w",
  "Mod-r",
  "Mod-Shift-i",
  "Mod-Shift-j",
]);

export function isReserved(combo: string): boolean {
  return RESERVED_COMBOS.has(combo);
}

/** The id of another command already using `combo`, if any. */
export function conflictingId(
  id: string,
  combo: string,
  resolved: Record<string, string | null>,
): string | undefined {
  for (const [otherId, key] of Object.entries(resolved)) {
    if (otherId !== id && key === combo) return otherId;
  }
  return undefined;
}
