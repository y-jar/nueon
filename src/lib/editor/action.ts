import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import type { Action } from "svelte/action";

import type { WordIndex } from "../api";
import {
  dictionaryHighlight,
  dictionaryHover,
  setWordIndex,
  wordIndexField,
} from "./dictionary";
import {
  EMPTY_FORMAT,
  formatAt,
  markdownKeymap,
  type FormatState,
} from "./commands";
import { livePreview, setAssetBase } from "./livePreview";
import { highlight, theme } from "./theme";

export interface EditorParams {
  path: string;
  content: string;
  index: WordIndex;
  /** Absolute `notes/` directory for resolving local images. */
  assetBase: string;
  onDirty: (dirty: boolean) => void;
  onSave: (path: string, text: string) => Promise<void>;
  /** Called with the live view once created, and `null` on destroy. */
  onView?: (view: EditorView | null) => void;
  /** Called when the formats active at the cursor change. */
  onFormat?: (format: FormatState) => void;
  /** Right-click inside the editor. */
  onContextMenu?: (x: number, y: number, view: EditorView) => void;
}

const AUTOSAVE_MS = 400;

/**
 * Svelte action that owns a CodeMirror `EditorView`. It flushes the debounced
 * autosave on blur, on note switch, and on destroy so edits are never dropped.
 */
export const codemirror: Action<HTMLElement, EditorParams> = (node, params) => {
  let current: EditorParams = params;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const view = new EditorView({
    parent: node,
    state: EditorState.create({
      doc: params.content,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        rectangularSelection(),
        crosshairCursor(),
        EditorView.lineWrapping,
        markdown({ extensions: [GFM] }),
        highlight,
        theme,
        wordIndexField,
        livePreview(),
        dictionaryHighlight(),
        dictionaryHover(),
        search({ top: true }),
        highlightSelectionMatches(),
        // Ahead of the default keymap, which binds Mod-i to "select parent".
        Prec.high(keymap.of(markdownKeymap)),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
          {
            key: "Mod-s",
            run: () => {
              void flush();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            current.onDirty(true);
            schedule();
          }
          if (update.docChanged || update.selectionSet) {
            current.onFormat?.(formatAt(update.state));
          }
        }),
        EditorView.domEventHandlers({
          blur: () => {
            void flush();
          },
          contextmenu: (event, view) => {
            if (!current.onContextMenu) return false;
            event.preventDefault();
            // Right-click places the cursor unless it lands in a selection.
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            const sel = view.state.selection.main;
            if (pos !== null && (sel.empty || pos < sel.from || pos > sel.to)) {
              view.dispatch({ selection: { anchor: pos } });
            }
            current.onContextMenu(event.clientX, event.clientY, view);
            return true;
          },
        }),
      ],
    }),
  });

  view.dispatch({ effects: setWordIndex.of(params.index) });
  setAssetBase(params.assetBase);
  params.onView?.(view);
  params.onFormat?.(formatAt(view.state) ?? EMPTY_FORMAT);

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const path = current.path;
    const text = view.state.doc.toString();
    try {
      await current.onSave(path, text);
      current.onDirty(false);
    } catch {
      // Keep the dirty flag set so the next flush retries.
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, AUTOSAVE_MS);
  }

  return {
    update(next: EditorParams) {
      if (next.path !== current.path) {
        // Flush the outgoing note before replacing the document.
        const previous = current;
        const outgoing = view.state.doc.toString();
        void (async () => {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          try {
            await previous.onSave(previous.path, outgoing);
          } catch {
            // ignore; the note remains on disk as last saved
          }
          current = next;
          setAssetBase(next.assetBase);
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: next.content },
            selection: { anchor: 0 },
          });
          view.dispatch({ effects: setWordIndex.of(next.index) });
          next.onDirty(false);
        })();
      } else {
        if (next.index !== current.index) {
          view.dispatch({ effects: setWordIndex.of(next.index) });
        }
        if (next.assetBase !== current.assetBase) {
          setAssetBase(next.assetBase);
          view.dispatch({});
        }
        current = next;
      }
    },
    async destroy() {
      current.onView?.(null);
      await flush();
      view.destroy();
    },
  };
};
