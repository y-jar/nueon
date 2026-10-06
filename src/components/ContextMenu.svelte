<script lang="ts">
  import { t } from "svelte-i18n";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import * as api from "../lib/api";
  import {
    ui,
    closeContextMenu,
    requestNew,
    requestRename,
    requestDeleteNote,
    selectNote,
    refreshTree,
    collapseAll,
    closeTab,
    moveTabToNewWindow,
    getContextEditor,
  } from "../lib/state.svelte";
  import type { EditorView } from "@codemirror/view";
  import {
    insertTable,
    insertHorizontalRule,
    insertLink,
    toggleBlockquote,
    toggleTaskList,
    toggleCodeBlock,
  } from "../lib/editor/commands";

  /** Close the menu, then apply an editing command to the editor it opened on. */
  function editorAction(command: (view: EditorView) => boolean) {
    const view = getContextEditor();
    closeContextMenu();
    if (!view) return;
    command(view);
    view.focus();
  }

  let menuEl: HTMLElement | undefined;

  // Portal the menu to <body> so it is never clipped by pane overflow.
  function portal(node: HTMLElement) {
    menuEl = node;
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
        menuEl = undefined;
      },
    };
  }

  const menu = $derived(ui.contextMenu);

  const TYPES: { id: api.FieldType; label: string }[] = [
    { id: "text", label: "Text" },
    { id: "tag_list", label: "List" },
    { id: "references", label: "Relation" },
    { id: "boolean", label: "Checkbox" },
  ];

  const base = $derived(
    menu
      ? menu.isDir
        ? menu.path
        : menu.path.split("/").slice(0, -1).join("/")
      : "",
  );

  function reveal() {
    if (!menu || !ui.root) return;
    const target = menu.path
      ? `${ui.root}/notes/${menu.path}`
      : `${ui.root}/notes`;
    revealItemInDir(target).catch(() => {});
    closeContextMenu();
  }

  $effect(() => {
    if (!ui.contextMenu) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    const onScroll = () => closeContextMenu();
    const onPointerDown = (event: MouseEvent) => {
      if (menuEl && !menuEl.contains(event.target as Node)) {
        closeContextMenu();
      }
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("mousedown", onPointerDown, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("mousedown", onPointerDown, true);
    };
  });
</script>

{#if menu}
  <div
    class="ctx-menu"
    role="menu"
    tabindex="-1"
    use:portal
    style="left: {menu.x}px; top: {menu.y}px"
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#if menu.kind === "root"}
      <button onclick={() => requestNew("note", "")}
        >{$t("contextMenu.newNote")}</button
      >
      <button onclick={() => requestNew("folder", "")}
        >{$t("contextMenu.newFolder")}</button
      >
      <button
        onclick={() => {
          refreshTree();
          closeContextMenu();
        }}>{$t("contextMenu.refresh")}</button
      >
      <button
        onclick={() => {
          collapseAll();
          closeContextMenu();
        }}>{$t("contextMenu.collapseAll")}</button
      >
      <button onclick={reveal}>{$t("contextMenu.reveal")}</button>
      <button
        onclick={() => {
          closeContextMenu();
          ui.trashOpen = true;
        }}>{$t("trash.open")}</button
      >
    {:else if menu.kind === "column" && menu.column}
      {@const col = menu.column}
      {#if col.canHide}
        <button
          onclick={() => {
            col.onHide();
            closeContextMenu();
          }}>{$t("grid.hideColumn")}</button
        >
      {/if}
      <button
        onclick={() => {
          col.onSortAsc();
          closeContextMenu();
        }}>{$t("grid.sortAsc")}</button
      >
      <button
        onclick={() => {
          col.onSortDesc();
          closeContextMenu();
        }}>{$t("grid.sortDesc")}</button
      >
      <button
        onclick={() => {
          col.onClearSort();
          closeContextMenu();
        }}>{$t("grid.clearSort")}</button
      >
      {#if col.isTag && col.onChangeKind}
        <div class="ctx-submenu">
          <span class="muted">{$t("grid.changeType")}</span>
          {#each TYPES as type (type.id)}
            <button
              class:active={col.kind === type.id}
              onclick={() => {
                col.onChangeKind?.(type.id);
                closeContextMenu();
              }}>{type.label}</button
            >
          {/each}
        </div>
      {/if}
      {#if col.isTag && col.onDelete}
        <button
          class="danger"
          onclick={() => {
            col.onDelete?.();
            closeContextMenu();
          }}>{$t("grid.deleteTag")}</button
        >
      {/if}
    {:else if menu.kind === "editor"}
      <button onclick={() => editorAction(insertTable)}
        >{$t("editor.menu.table")}</button
      >
      <button onclick={() => editorAction(toggleBlockquote)}
        >{$t("editor.menu.blockquote")}</button
      >
      <button onclick={() => editorAction(toggleTaskList)}
        >{$t("editor.menu.taskList")}</button
      >
      <button onclick={() => editorAction(toggleCodeBlock)}
        >{$t("editor.codeBlock")}</button
      >
      <button onclick={() => editorAction(insertHorizontalRule)}
        >{$t("editor.menu.rule")}</button
      >
      <button onclick={() => editorAction(insertLink)}
        >{$t("editor.menu.link")}</button
      >
    {:else if menu.kind === "tab" && menu.tab}
      <!-- Read the target before closing: closing nulls `menu`. -->
      <button
        onclick={() => {
          const { groupId, tabId } = menu.tab!;
          closeContextMenu();
          void moveTabToNewWindow(groupId, tabId);
        }}>{$t("contextMenu.moveToWindow")}</button
      >
      <button
        onclick={() => {
          const { groupId, tabId } = menu.tab!;
          closeContextMenu();
          closeTab(groupId, tabId);
        }}>{$t("tabs.close")}</button
      >
    {:else}
      {#if !menu.isDir}
        <button
          onclick={() => {
            selectNote(menu.path);
            closeContextMenu();
          }}>{$t("contextMenu.open")}</button
        >
      {/if}
      <button onclick={() => requestNew("note", base)}
        >{$t("contextMenu.newNote")}</button
      >
      <button onclick={() => requestNew("folder", base)}
        >{$t("contextMenu.newFolder")}</button
      >
      <button onclick={() => requestRename(menu.path)}
        >{$t("contextMenu.rename")}</button
      >
      <button
        onclick={() => {
          // Snapshot the target: closing the menu clears it.
          const target = menu.path;
          const isDir = menu.isDir;
          closeContextMenu();
          void requestDeleteNote(target, isDir);
        }}>{$t("contextMenu.delete")}</button
      >
      <button onclick={reveal}>{$t("contextMenu.reveal")}</button>
    {/if}
  </div>
{/if}
