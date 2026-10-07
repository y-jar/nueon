/**
 * Multiple selections for the note editor.
 *
 * CodeMirror disables multiple selections unless the editor enables them, so
 * `Ctrl`/`Cmd`+click (its default gesture) and every command that acts on
 * several ranges need this. The drop cursor shows where a dragged block of
 * text will land. The default click gesture and rectangular selection
 * (`Alt`+drag) are left untouched.
 */
import { EditorState } from "@codemirror/state";
import { dropCursor } from "@codemirror/view";

/** Allow multiple selections, and show the drop cursor while dragging text. */
export function multiSelect() {
  return [EditorState.allowMultipleSelections.of(true), dropCursor()];
}
