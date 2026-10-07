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
import { diffSplice } from "./diff";
import { livePreview, setAssetBase } from "./livePreview";
import { initialPosition, restoreScroll, savePosition } from "./positions";
import { highlight, theme } from "./theme";

export interface EditorParams {
  path: string;
  /** The note's text as last read from disk. */
  content: string;
  /** Hash of `content`; saves are refused if the file no longer matches. */
  hash: string | null;
  index: WordIndex;
  /** Absolute `notes/` directory for resolving local images. */
  assetBase: string;
  onDirty: (dirty: boolean) => void;
  /** Persist an existing note; resolves to the new content hash. */
  onSave: (path: string, text: string, baseHash: string | null) => Promise<string>;
  /** A save succeeded: `text` is now on disk and `hash` is its hash. */
  onSaved?: (hash: string, text: string) => void;
  /** The file changed on disk, or vanished, while the buffer has edits. */
  onConflict?: (kind: "changed" | "missing") => void;
  /** Called with the live view once created, and `null` on destroy. */
  onView?: (view: EditorView | null) => void;
  /** Called when the formats active at the cursor change. */
  onFormat?: (format: FormatState) => void;
  /** Right-click inside the editor. */
  onContextMenu?: (x: number, y: number, view: EditorView) => void;
}

const AUTOSAVE_MS = 400;

/**
 * One live editor for one note. Sessions let the rest of the app flush,
 * freeze, or resolve an open note around file operations (delete, rename, a
 * conflict) so an editor never writes to a path that no longer exists.
 */
interface Session {
  path(): string;
  /** Save pending edits now (serialized with any save in flight). */
  flush(): Promise<void>;
  /** Stop saving; returns a function that resumes. */
  freeze(): () => void;
  /** Throw away the buffer in favour of the file's text. */
  reload(content: string, hash: string): void;
  /** Keep the buffer and treat it as based on the file's current hash. */
  adopt(hash: string): void;
}

const sessions = new Set<Session>();

function covers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Save pending edits of every open note at or under `prefix`. */
export async function flushNotes(prefix: string): Promise<void> {
  await Promise.all(
    [...sessions].filter((s) => covers(prefix, s.path())).map((s) => s.flush()),
  );
}

/**
 * Freeze every open note at or under `prefix` and wait for saves in flight.
 * Call before deleting or renaming; the returned function undoes the freeze
 * if the operation fails.
 */
export async function quiesceNotes(prefix: string): Promise<() => void> {
  const targets = [...sessions].filter((s) => covers(prefix, s.path()));
  const resumes = targets.map((s) => s.freeze());
  await Promise.all(targets.map((s) => s.flush()));
  return () => resumes.forEach((resume) => resume());
}

/** Resolve a conflict for the open note at `path`. */
export function resolveNoteConflict(
  path: string,
  choice: "reload" | "adopt",
  snapshot: { content: string; hash: string },
): void {
  for (const session of sessions) {
    if (session.path() !== path) continue;
    if (choice === "reload") session.reload(snapshot.content, snapshot.hash);
    else session.adopt(snapshot.hash);
  }
}

/**
 * Svelte action that owns a CodeMirror `EditorView`. It flushes the debounced
 * autosave on blur, on note switch, and on destroy so edits are never dropped.
 */
export const codemirror: Action<HTMLElement, EditorParams> = (node, params) => {
  let current: EditorParams = params;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The text last known to be on disk. */
  let savedText = params.content;
  /** Hash the next save is checked against. */
  let baseHash: string | null = params.hash;
  let frozen = 0;
  let conflicted = false;
  /** Saves run strictly one after another so each uses the previous hash. */
  let queue: Promise<void> = Promise.resolve();

  // A remount (tab switch, rename) starts already placed where the previous
  // editor left off: initial selection + scroll are construction options,
  // so no corrective dispatch disturbs the first measure.
  const restored = initialPosition(params.path, params.content.length);

  const view = new EditorView({
    parent: node,
    state: EditorState.create({
      doc: params.content,
      ...(restored
        ? { selection: { anchor: restored.anchor, head: restored.head } }
        : {}),
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
          if (update.selectionSet) {
            // Keep the remembered position fresh; a rename reads it before
            // this editor's destroy hook gets to save it.
            savePosition(current.path, view);
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
  setAssetBase(params.assetBase, params.path);
  params.onView?.(view);
  params.onFormat?.(formatAt(view.state) ?? EMPTY_FORMAT);
  if (restored) restoreScroll(view, restored.top);

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    queue = queue.then(save, save);
    return queue;
  }

  async function save(): Promise<void> {
    // Never save while frozen (the note is being deleted/renamed) or while a
    // conflict is unresolved, and never write text that is already on disk.
    if (frozen > 0 || conflicted) return;
    const text = view.state.doc.toString();
    if (text === savedText) {
      current.onDirty(false);
      return;
    }
    const path = current.path;
    try {
      const hash = await current.onSave(path, text, baseHash);
      savedText = text;
      baseHash = hash;
      current.onSaved?.(hash, text);
      if (view.state.doc.toString() === text) current.onDirty(false);
    } catch (error) {
      const message = String(error);
      if (message.includes("conflict")) {
        conflicted = true;
        current.onConflict?.("changed");
      } else if (message.includes("not found")) {
        conflicted = true;
        current.onConflict?.("missing");
      }
      // Anything else (transient I/O): stay dirty so the next flush retries.
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, AUTOSAVE_MS);
  }

  /**
   * Replace the buffer with text from disk as one minimal splice: the
   * cursor and scroll position map through the change instead of resetting.
   */
  function replaceBuffer(content: string): void {
    const splice = diffSplice(view.state.doc.toString(), content);
    if (splice) {
      view.dispatch({
        changes: { from: splice.from, to: splice.to, insert: splice.insert },
      });
    }
  }

  const session: Session = {
    path: () => current.path,
    flush,
    freeze() {
      frozen += 1;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      let resumed = false;
      return () => {
        if (resumed) return;
        resumed = true;
        frozen = Math.max(0, frozen - 1);
      };
    },
    reload(content, hash) {
      conflicted = false;
      savedText = content;
      baseHash = hash;
      replaceBuffer(content);
      current.onDirty(false);
    },
    adopt(hash) {
      conflicted = false;
      baseHash = hash;
      schedule();
    },
  };
  sessions.add(session);

  return {
    update(next: EditorParams) {
      if (next.path !== current.path) {
        // The same editor now shows another note: save the old one first.
        const previous = current;
        void (async () => {
          await flush();
          current = next;
          savedText = next.content;
          baseHash = next.hash;
          conflicted = false;
          setAssetBase(next.assetBase, next.path);
          replaceBuffer(next.content);
          view.dispatch({ effects: setWordIndex.of(next.index) });
          previous.onDirty(false);
          next.onDirty(false);
        })();
        return;
      }

      if (next.index !== current.index) {
        view.dispatch({ effects: setWordIndex.of(next.index) });
      }
      if (next.assetBase !== current.assetBase) {
        setAssetBase(next.assetBase, next.path);
        view.dispatch({});
      }
      current = next;

      // The file changed on disk (another window, git, an external editor).
      const clean = view.state.doc.toString() === savedText;
      if (clean && next.hash !== null && next.content !== savedText) {
        // Nothing unsaved: quietly follow the file.
        savedText = next.content;
        baseHash = next.hash;
        replaceBuffer(next.content);
        next.onDirty(false);
      } else if (
        !clean &&
        next.hash !== null &&
        next.hash !== baseHash &&
        !conflicted
      ) {
        conflicted = true;
        next.onConflict?.("changed");
      }
    },
    async destroy() {
      // Outlive the remount: the next editor for this path restores these.
      savePosition(current.path, view);
      current.onView?.(null);
      sessions.delete(session);
      await flush();
      view.destroy();
    },
  };
};
