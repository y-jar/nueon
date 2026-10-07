<script lang="ts">
  import { t } from "svelte-i18n";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { COLUMN_TYPES } from "../lib/dictionary";
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
    closePane,
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
    toggleStrikethrough,
    setHeading,
    clearHeading,
  } from "../lib/editor/commands";
  import {
    deleteTableColumn,
    deleteTableRow,
    formatTable,
    getTableAtCursor,
    insertColumnLeft,
    insertColumnRight,
    insertRowAbove,
    insertRowBelow,
    setColumnAlignment,
  } from "../lib/editor/tableEditing";

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

  // The table under the cursor when an editor menu opens, or null.
  const table = $derived.by(() => {
    if (!menu || menu.kind !== "editor") return null;
    const view = getContextEditor();
    return view ? getTableAtCursor(view.state) : null;
  });

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
          {#each COLUMN_TYPES as type (type.id)}
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
      {#if table}
        <div class="ctx-submenu">
          <span class="muted">{$t("editor.table.rows")}</span>
          <button onclick={() => editorAction(insertRowAbove)}
            >{$t("editor.table.rowAbove")}</button
          >
          <button onclick={() => editorAction(insertRowBelow)}
            >{$t("editor.table.rowBelow")}</button
          >
          <button
            disabled={table.row < 0}
            onclick={() => editorAction(deleteTableRow)}
            >{$t("editor.table.deleteRow")}</button
          >
        </div>
        <div class="ctx-submenu">
          <span class="muted">{$t("editor.table.columns")}</span>
          <button onclick={() => editorAction(insertColumnLeft)}
            >{$t("editor.table.columnLeft")}</button
          >
          <button onclick={() => editorAction(insertColumnRight)}
            >{$t("editor.table.columnRight")}</button
          >
          <button
            disabled={table.model.header.length <= 1}
            onclick={() => editorAction(deleteTableColumn)}
            >{$t("editor.table.deleteColumn")}</button
          >
        </div>
        <div class="ctx-submenu">
          <span class="muted">{$t("editor.table.align")}</span>
          <button
            class:active={table.align === "left"}
            onclick={() => editorAction(setColumnAlignment("left"))}
            >{$t("editor.table.alignLeft")}</button
          >
          <button
            class:active={table.align === "center"}
            onclick={() => editorAction(setColumnAlignment("center"))}
            >{$t("editor.table.alignCenter")}</button
          >
          <button
            class:active={table.align === "right"}
            onclick={() => editorAction(setColumnAlignment("right"))}
            >{$t("editor.table.alignRight")}</button
          >
          <button
            class:active={table.align === "none"}
            onclick={() => editorAction(setColumnAlignment("none"))}
            >{$t("editor.table.alignNone")}</button
          >
        </div>
        <button onclick={() => editorAction(formatTable)}
          >{$t("editor.table.format")}</button
        >
      {:else}
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
        <div class="ctx-submenu">
          <span class="muted">{$t("editor.heading")}</span>
          {#each [1, 2, 3, 4, 5, 6] as level (level)}
            <button onclick={() => editorAction(setHeading(level))}
              >{$t("editor.headingLevel", { values: { level } })}</button
            >
          {/each}
          <button onclick={() => editorAction(clearHeading)}
            >{$t("editor.normalText")}</button
          >
        </div>
        <button onclick={() => editorAction(toggleStrikethrough)}
          >{$t("editor.strikethrough")} (Ctrl+Shift+X)</button
        >
      {/if}
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
      <button
        onclick={() => {
          const { groupId } = menu.tab!;
          closeContextMenu();
          closePane(groupId);
        }}>{$t("tabs.closePane")}</button
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
