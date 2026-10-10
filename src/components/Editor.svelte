<script lang="ts">
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import {
    ui,
    activeDoc,
    openEditorContextMenu,
    openTable,
    resolveConflict,
    requestDeleteNote,
    selectNote,
    setEditorLineNumbers,
    noteFilePath,
    type DocState,
  } from "../lib/state.svelte";
  import { headingLine, notePathSet, parseHeadings, type WikiTarget } from "../lib/wikilink";
  import {
    revealInFileExplorer,
    openInDefaultApp,
    copyText,
  } from "../lib/fileActions";
  import { EditorView } from "@codemirror/view";
  import EditorToolbar from "./EditorToolbar.svelte";
  import {
    EMPTY_FORMAT,
    insertImageMarkdown,
    type FormatState,
  } from "../lib/editor/commands";
  import { codemirror } from "../lib/editor/action";
  import { invalidateReads } from "../lib/editor/freshness";
  import { shouldApplySave } from "../lib/editor/session";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import { EllipsisVertical, Upload } from "@lucide/svelte";
  import Popover from "./Popover.svelte";
  import { assetLink, linkLabel } from "../lib/assets";
  import { stripMd } from "../lib/explorer";

  let { doc }: { doc: DocState } = $props();

  let view = $state<EditorView | null>(null);
  let format = $state<FormatState>({ ...EMPTY_FORMAT });

  const notePaths = $derived(notePathSet(ui.tree));

  // Cache the open note's headings so `[[note#heading]]` resolves and the
  // broken-heading style is accurate once the note has loaded.
  $effect(() => {
    const path = doc.selected;
    if (!path) return;
    const headings = parseHeadings(doc.noteContent);
    if (
      JSON.stringify(ui.noteHeadings[path]) === JSON.stringify(headings)
    ) {
      return;
    }
    ui.noteHeadings = { ...ui.noteHeadings, [path]: headings };
  });

  // A pending "scroll to heading" request: this editor scrolls once its note
  // is the one the request names.
  $effect(() => {
    const request = ui.scrollToHeading;
    if (!request || doc.selected !== request.path) return;
    const line = headingLine(doc.noteContent, request.heading);
    if (!view || !line) {
      ui.scrollToHeading = null;
      return;
    }
    const target = view.state.doc.line(line);
    view.dispatch({ selection: { anchor: target.from } });
    view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "start" }) });
    ui.scrollToHeading = null;
  });

  /** Ctrl/Cmd+click on a `[[...]]` link: open its target. */
  async function followLink(target: WikiTarget) {
    if (target.kind === "word") {
      await openTable(target.table);
      activeDoc().selectedEntry = target.id;
    } else if (target.kind === "note") {
      await selectNote(target.path);
      if (target.heading) {
        ui.scrollToHeading = { path: target.path, heading: target.heading };
      }
    }
  }

  /** Read a note's headings, caching them for `[[note#heading]]`. */
  async function resolveHeadings(path: string): Promise<string[]> {
    const cached = ui.noteHeadings[path];
    if (cached) return cached;
    const snapshot = await api.readNote(path);
    const headings = parseHeadings(snapshot.content);
    ui.noteHeadings = { ...ui.noteHeadings, [path]: headings };
    return headings;
  }

  /** Create an empty note in the current note's folder (dropdown fallback). */
  async function createLinkNote(name: string): Promise<void> {
    const folder = (doc.selected ?? "").split("/").slice(0, -1).join("/");
    const relative = folder ? `${folder}/${name}` : name;
    await api.createNote(relative);
  }

  /** Ask for a destination, then export the note's current text. */
  async function exportAs(format: api.ExportFormat) {
    const target = view;
    const note = doc.selected;
    if (!target || !note) return;
    const name = stripMd(note.split("/").pop() ?? "note");
    try {
      const destination = await save({
        defaultPath: `${name}.${format}`,
        filters: [
          {
            name: format === "pdf" ? "PDF document" : "OpenDocument text",
            extensions: [format],
          },
        ],
      });
      if (!destination) return;
      ui.status = $t("status.exporting", { values: { name } });
      ui.status = await api.exportDocument(
        format,
        note,
        target.state.doc.toString(),
        destination,
      );
    } catch (error) {
      ui.status = $t("status.exportFailed", { values: { error: String(error) } });
    }
  }

  /** Pick an image, import it to `assets/`, and reference it from the note. */
  async function insertImage() {
    const target = view;
    const note = doc.selected;
    if (!target || !note) return;
    try {
      const picked = await open({
        multiple: false,
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"],
          },
        ],
      });
      if (typeof picked !== "string") return;
      const asset = await api.importAsset(picked);
      insertImageMarkdown(
        target,
        linkLabel(asset.original_name),
        assetLink(note, asset.name),
      );
      target.focus();
    } catch (error) {
      ui.status = $t("status.couldNotInsertImage", { values: { error: String(error) } });
    }
  }
</script>

{#if doc.selected}
  <div class="editor">
    {#if doc.conflict}
      <div class="conflict-banner" role="alert">
        <span class="grow">
          {doc.conflict === "missing"
            ? $t("editor.conflictMissing")
            : $t("editor.conflictChanged")}
        </span>
        {#if doc.conflict === "missing"}
          <button onclick={() => resolveConflict(doc, "recreate")}>
            {$t("editor.recreate")}
          </button>
        {:else}
          <button onclick={() => resolveConflict(doc, "use-disk")}>
            {$t("editor.useDisk")}
          </button>
          <button onclick={() => resolveConflict(doc, "keep-mine")}>
            {$t("editor.keepMine")}
          </button>
        {/if}
      </div>
    {/if}
    <EditorToolbar {view} {format} onImage={insertImage}>
      <Popover align="right">
        {#snippet label()}<Upload size={15} /> {$t("editor.export")}{/snippet}
        {#snippet children(close)}
          <div class="picker-body">
            <button
              onclick={() => {
                close();
                void exportAs("pdf");
              }}>{$t("editor.exportPdf")}</button
            >
            <button
              onclick={() => {
                close();
                void exportAs("odt");
              }}>{$t("editor.exportOdt")}</button
            >
          </div>
        {/snippet}
      </Popover>
      <Popover align="right">
        {#snippet label()}<span title={$t("editor.moreActions")}
            ><EllipsisVertical size={15} /></span
          >{/snippet}
        {#snippet children(close)}
          <div class="picker-body">
            <button
              onclick={() => {
                close();
                void copyText(noteFilePath(doc.selected ?? ""));
              }}>{$t("editor.menu.copyPath")}</button
            >
            <button
              onclick={() => {
                close();
                openInDefaultApp(noteFilePath(doc.selected ?? ""));
              }}>{$t("editor.menu.openDefault")}</button
            >
            <button
              onclick={() => {
                close();
                revealInFileExplorer(noteFilePath(doc.selected ?? ""));
              }}>{$t("editor.menu.reveal")}</button
            >
            <button
              onclick={() => {
                close();
                void setEditorLineNumbers(!ui.showLineNumbers);
              }}>{ui.showLineNumbers
                ? $t("editor.menu.hideLineNumbers")
                : $t("editor.menu.showLineNumbers")}</button
            >
            <button
              class="danger"
              onclick={() => {
                const path = doc.selected;
                close();
                if (path) void requestDeleteNote(path, false);
              }}>{$t("editor.menu.deleteFile")}</button
            >
          </div>
        {/snippet}
      </Popover>
    </EditorToolbar>
    <div class="editor-inner">
      <div class="editor-head">
        <span class="muted">{stripMd(doc.selected)}{doc.dirty ? " •" : ""}</span>
      </div>
      <div
        class="cm-host"
        data-note={doc.selected}
        use:codemirror={{
          path: doc.selected,
          content: doc.noteContent,
          hash: doc.noteHash,
          index: ui.wordIndex,
          notePaths,
          noteHeadings: ui.noteHeadings,
          fixesTables: ui.fixesTables,
          assetBase: ui.root ? `${ui.root}/notes` : "",
          onFollow: followLink,
          onResolveHeadings: resolveHeadings,
          onCreateLinkNote: createLinkNote,
          onDirty: (path: string, dirty: boolean) => {
            if (shouldApplySave(doc.selected, path)) doc.dirty = dirty;
          },
          onSave: api.saveNote,
          onSaved: (path: string, hash: string, text: string) => {
            // A save for a note no longer shown (a tab switch landed while it
            // was in flight) must not overwrite the shown note's copy.
            if (!shouldApplySave(doc.selected, path)) return;
            // Keep the loaded copy in step with disk so a remount (rename,
            // tab switch) never starts from stale text. Any disk read that
            // was in flight while we saved is now stale.
            invalidateReads(path);
            doc.noteContent = text;
            doc.noteHash = hash;
          },
          onConflict: (path: string, kind: "changed" | "missing") => {
            if (shouldApplySave(doc.selected, path)) doc.conflict = kind;
          },
          onView: (next: EditorView | null) => (view = next),
          onFormat: (next: FormatState) => (format = next),
          onContextMenu: openEditorContextMenu,
          onImage: insertImage,
          showLineNumbers: ui.showLineNumbers,
          keybinds: ui.keybinds,
        }}
      ></div>
    </div>
  </div>
{:else}
  <div class="placeholder">{$t("editor.selectNote")}</div>
{/if}
