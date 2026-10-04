import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
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
import { livePreview } from "./livePreview";
import { highlight, theme } from "./theme";

export interface EditorParams {
  path: string;
  content: string;
  index: WordIndex;
  onDirty: (dirty: boolean) => void;
  onSave: (path: string, text: string) => Promise<void>;
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
        }),
        EditorView.domEventHandlers({
          blur: () => {
            void flush();
          },
        }),
      ],
    }),
  });

  view.dispatch({ effects: setWordIndex.of(params.index) });

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
        current = next;
      }
    },
    async destroy() {
      await flush();
      view.destroy();
    },
  };
};
