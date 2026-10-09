/**
 * The read-only keybind reference shown in Settings. Kept as plain data (no
 * editor imports) so it can feed the UI directly; a test keeps the Markdown
 * and Tables groups in step with the real keymaps.
 */

export interface Keybind {
  /** CodeMirror key notation, e.g. `Mod-Shift-l`. */
  keys: string;
  labelKey: string;
  values?: Record<string, string | number>;
}

export interface KeybindGroup {
  titleKey: string;
  bindings: Keybind[];
}

/** `Mod-Shift-l` → `Ctrl+Shift+L`. */
export function formatKeys(keys: string): string {
  const parts = keys.split("-").map((part) => (part === "Mod" ? "Ctrl" : part));
  const last = parts.length - 1;
  if (/^[a-z]$/.test(parts[last])) parts[last] = parts[last].toUpperCase();
  return parts.join("+");
}

export const KEYBIND_GROUPS: KeybindGroup[] = [
  {
    titleKey: "keybinds.groupMarkdown",
    bindings: [
      { keys: "Mod-b", labelKey: "keybinds.bold" },
      { keys: "Mod-i", labelKey: "keybinds.italic" },
      { keys: "Mod-u", labelKey: "keybinds.underline" },
      { keys: "Mod-k", labelKey: "keybinds.link" },
      { keys: "Mod-Shift-8", labelKey: "keybinds.bulletList" },
      { keys: "Mod-Shift-7", labelKey: "keybinds.numberedList" },
      { keys: "Mod-Shift-9", labelKey: "keybinds.blockquote" },
      { keys: "Mod-Shift-l", labelKey: "keybinds.taskList" },
      { keys: "Mod-Shift-t", labelKey: "keybinds.table" },
      { keys: "Mod-Shift-c", labelKey: "keybinds.codeBlock" },
      { keys: "Mod-1", labelKey: "keybinds.heading", values: { level: 1 } },
      { keys: "Mod-2", labelKey: "keybinds.heading", values: { level: 2 } },
      { keys: "Mod-3", labelKey: "keybinds.heading", values: { level: 3 } },
      { keys: "Mod-4", labelKey: "keybinds.heading", values: { level: 4 } },
      { keys: "Mod-5", labelKey: "keybinds.heading", values: { level: 5 } },
      { keys: "Mod-6", labelKey: "keybinds.heading", values: { level: 6 } },
      { keys: "Mod-0", labelKey: "keybinds.clearHeading" },
      { keys: "Mod-Shift-x", labelKey: "keybinds.strikethrough" },
      { keys: "Mod-Shift-p", labelKey: "keybinds.image" },
    ],
  },
  {
    titleKey: "keybinds.groupTables",
    bindings: [
      { keys: "Tab", labelKey: "keybinds.nextCell" },
      { keys: "Shift-Tab", labelKey: "keybinds.prevCell" },
      { keys: "Enter", labelKey: "keybinds.nextRow" },
    ],
  },
  {
    titleKey: "keybinds.groupEditing",
    bindings: [
      { keys: "Mod-s", labelKey: "keybinds.save" },
      { keys: "Tab", labelKey: "keybinds.indent" },
      { keys: "Mod-f", labelKey: "keybinds.find" },
    ],
  },
];
