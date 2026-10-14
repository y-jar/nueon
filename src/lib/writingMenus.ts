//! Pure menu definitions for the vector editor's menu bar.

export type MenuId = "file" | "edit" | "view" | "tools" | "metrics" | "glyphs" | "export";

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
}

export interface MenuState {
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  hasComponent: boolean;
  hasElements: boolean;
  allHandles: boolean;
  snap: boolean;
  guides: boolean;
  hasGlyph: boolean;
}

export const MENU_ORDER: MenuId[] = ["file", "edit", "view", "tools", "metrics", "glyphs", "export"];

export const MENU_LABELS: Record<MenuId, string> = {
  file: "File",
  edit: "Edit",
  view: "View",
  tools: "Tools",
  metrics: "Metrics",
  glyphs: "Glyphs",
  export: "Export",
};

const sep = (id: string): MenuItem => ({ id, label: "", separator: true });

/** The items of a menu for the current editor state. Metrics is a form, not a list. */
export function menuItems(menu: MenuId, state: MenuState): MenuItem[] {
  switch (menu) {
    case "file":
      return [
        { id: "import-svg", label: "Import SVG\u2026", disabled: !state.hasGlyph },
        sep("s1"),
        { id: "close", label: "Close glyph" },
      ];
    case "edit":
      return [
        { id: "undo", label: "Undo", shortcut: "Ctrl+Z", disabled: !state.canUndo },
        { id: "redo", label: "Redo", shortcut: "Ctrl+Shift+Z", disabled: !state.canRedo },
        sep("s1"),
        { id: "select-all", label: "Select all", shortcut: "Ctrl+A" },
        { id: "duplicate", label: "Duplicate", shortcut: "Ctrl+D", disabled: !state.hasElements },
        { id: "delete", label: "Delete", shortcut: "Del" },
        sep("s2"),
        { id: "mirror-h", label: "Flip horizontal", disabled: !state.hasGlyph },
        { id: "mirror-v", label: "Flip vertical", disabled: !state.hasGlyph },
        { id: "scale-up", label: "Scale up 110%", disabled: !state.hasGlyph },
        { id: "scale-down", label: "Scale down 90%", disabled: !state.hasGlyph },
        { id: "rotate-cw", label: "Rotate 15\u00b0 clockwise", disabled: !state.hasGlyph },
        { id: "rotate-ccw", label: "Rotate 15\u00b0 counter-clockwise", disabled: !state.hasGlyph },
        { id: "shear", label: "Shear 10\u00b0", disabled: !state.hasGlyph },
        sep("s3"),
        { id: "align-left", label: "Align left" },
        { id: "align-hcenter", label: "Align centre" },
        { id: "align-right", label: "Align right" },
        { id: "align-top", label: "Align top" },
        { id: "align-vcenter", label: "Align middle" },
        { id: "align-bottom", label: "Align bottom" },
        { id: "distribute-h", label: "Distribute horizontally" },
        { id: "distribute-v", label: "Distribute vertically" },
        sep("s4"),
        { id: "order-front", label: "Bring to front" },
        { id: "order-up", label: "Bring forward" },
        { id: "order-down", label: "Send backward" },
        { id: "order-back", label: "Send to back" },
      ];
    case "view":
      return [
        { id: "zoom-in", label: "Zoom in" },
        { id: "zoom-out", label: "Zoom out" },
        { id: "zoom-fit", label: "Fit glyph", shortcut: "0" },
        { id: "zoom-actual", label: "100%", shortcut: "1" },
        { id: "toggle-handles", label: `${state.allHandles ? "\u2713 " : ""}Show all handles`, shortcut: "Shift+H" },
        sep("s1"),
        { id: "toggle-snap", label: `${state.snap ? "\u2713 " : ""}Snap to grid` },
        { id: "toggle-guides", label: `${state.guides ? "\u2713 " : ""}Guide rails` },
      ];
    case "tools":
      return [
        { id: "tool-select", label: "Select", shortcut: "V" },
        { id: "tool-direct", label: "Direct Select", shortcut: "A" },
        { id: "tool-hand", label: "Hand", shortcut: "H" },
        { id: "tool-zoom", label: "Zoom", shortcut: "Z" },
        { id: "tool-pen", label: "Pen", shortcut: "P" },
        { id: "tool-node", label: "Node Mod", shortcut: "N" },
        { id: "tool-brush", label: "Brush", shortcut: "B" },
        { id: "tool-shapes", label: "Shapes", shortcut: "S" },
        { id: "tool-mirror", label: "Mirror/Flip", shortcut: "M" },
        { id: "tool-eraser", label: "Eraser", shortcut: "E" },
        sep("s1"),
        { id: "node-kind", label: "Cycle node type", disabled: !state.hasSelection },
        { id: "component-expand", label: "Expand component", shortcut: "Ctrl+Shift+E", disabled: !state.hasComponent },
        { id: "node-join", label: "Join endpoints", shortcut: "Shift+J", disabled: !state.hasSelection },
        { id: "node-break", label: "Break node", shortcut: "Shift+B", disabled: !state.hasSelection },
        { id: "finish-path", label: "Finish path", shortcut: "Enter" },
      ];
    case "glyphs":
      return [
        { id: "glyph-new", label: "New glyph" },
        { id: "glyph-duplicate", label: "Duplicate glyph", disabled: !state.hasGlyph },
        { id: "glyph-delete", label: "Delete glyph", disabled: !state.hasGlyph },
        sep("s1"),
        { id: "glyph-prev", label: "Previous glyph" },
        { id: "glyph-next", label: "Next glyph" },
        sep("s2"),
        { id: "compose", label: "Composition matrix" },
      ];
    case "export":
      return [
        { id: "export-svg", label: "Export glyph as SVG\u2026", disabled: !state.hasGlyph },
        { id: "export-sprite", label: "Export all as SVG sprite\u2026" },
        sep("s1"),
        { id: "check-font", label: "Check font\u2026" },
        { id: "export-ttf", label: "Export font (.ttf)\u2026" },
        { id: "export-otf", label: "Export font (.otf) \u2014 coming soon", disabled: true },
      ];
    case "metrics":
      return [];
  }
}

/** The next/previous glyph id in order, wrapping around; null when there is no glyph. */
export function neighbourGlyph(ids: string[], current: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return ids[step === 1 ? 0 : ids.length - 1];
  return ids[(at + step + ids.length) % ids.length];
}

export type GuideField = "x_height" | "cap_height" | "ascender" | "descender";

export const GUIDE_FIELDS: { field: GuideField; label: string }[] = [
  { field: "ascender", label: "Ascender" },
  { field: "cap_height", label: "Cap height" },
  { field: "x_height", label: "x-height" },
  { field: "descender", label: "Descender" },
];

/** Parse a guide-height input; blank or non-numeric input is rejected. */
export function parseGuide(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
