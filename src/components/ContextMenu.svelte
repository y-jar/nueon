<!-- The portaled context menu for all menu kinds. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { revealInFileExplorer } from "../lib/fileActions";
  import { COLUMN_TYPES } from "../lib/dictionary";
  import {
    ui,
    closeContextMenu,
    duplicateTabToNewSplit,
    requestNew,
    requestRename,
    requestRenameTable,
    requestDeleteNote,
    requestDeleteTable,
    selectNote,
    selectNoteInSplit,
    selectTable,
    selectTableInSplit,
    refreshTree,
    collapseAll,
    closeTab,
    closeOtherTabs,
    closePaneTabs,
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

  // Portal the menu to <body> so it is never clipped by pane overflow, focus
  // its first item so the keyboard works immediately, and return focus to the
  // previously focused element when the menu closes.
  function portal(node: HTMLElement) {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    menuEl = node;
    document.body.appendChild(node);
    node.querySelector("button")?.focus();
    return {
      destroy() {
        node.remove();
        menuEl = undefined;
        previouslyFocused?.focus?.();
      },
    };
  }

  // Move focus between items: Arrow/Home/End, Enter activates the focused one.
  function onMenuKeydown(event: KeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...menuEl!.querySelectorAll<HTMLButtonElement>("button")];
    if (!buttons.length) return;
    const current = buttons.findIndex((b) => b === document.activeElement);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "ArrowDown") next = (current + 1 + buttons.length) % buttons.length;
    else next = (current - 1 + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
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

  // The column payload when this is a grid column menu, else null. A derived
  // value is used instead of an `{@const}` inside the branch: the branch is
  // destroyed when `menu` clears, and a stale `{@const}` can leave the menu
  // rendered (stuck) on some Svelte 5 revisions.
  const column = $derived.by(() =>
    menu && menu.kind === "column" && menu.column ? menu.column : null,
  );

  function reveal() {
    if (!menu || !ui.root) return;
    const target = menu.path
      ? `${ui.root}/notes/${menu.path}`
      : `${ui.root}/notes`;
    revealInFileExplorer(target);
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
    onkeydown={onMenuKeydown}
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
    {:else if column}
      {#if column.canHide}
        <button
          onclick={() => {
            column.onHide();
            closeContextMenu();
          }}>{$t("grid.hideColumn")}</button
        >
      {/if}
      <button
        onclick={() => {
          column.onSortAsc();
          closeContextMenu();
        }}>{$t("grid.sortAsc")}</button
      >
      <button
        onclick={() => {
          column.onSortDesc();
          closeContextMenu();
        }}>{$t("grid.sortDesc")}</button
      >
      <button
        onclick={() => {
          column.onClearSort();
          closeContextMenu();
        }}>{$t("grid.clearSort")}</button
      >
      {#if column.isTag && column.onChangeKind}
        <div class="ctx-submenu">
          <span class="muted">{$t("grid.changeType")}</span>
          {#each COLUMN_TYPES as type (type.id)}
            <button
              class:active={column.kind === type.id}
              onclick={() => {
                column.onChangeKind?.(type.id);
                closeContextMenu();
              }}>{type.label}</button
            >
          {/each}
        </div>
      {/if}
      {#if column.isTag && column.onDelete}
        <button
          class="danger"
          onclick={() => {
            column.onDelete?.();
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
          void duplicateTabToNewSplit(groupId, tabId);
        }}>{$t("contextMenu.openInNewSplit")}</button
      >
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
          const { groupId, tabId } = menu.tab!;
          closeContextMenu();
          closeOtherTabs(groupId, tabId);
        }}>{$t("tabs.closeOthers")}</button
      >
      <button
        onclick={() => {
          const { groupId } = menu.tab!;
          closeContextMenu();
          closePaneTabs(groupId);
        }}>{$t("tabs.closeAllInPane")}</button
      >
      <button
        onclick={() => {
          const { groupId } = menu.tab!;
          closeContextMenu();
          closePane(groupId);
        }}>{$t("tabs.closePane")}</button
      >
    {:else if menu.kind === "table" && menu.table}
      <button
        onclick={() => {
          const name = menu.table!;
          closeContextMenu();
          void selectTable(name);
        }}>{$t("contextMenu.open")}</button
      >
      <button
        onclick={() => {
          const name = menu.table!;
          closeContextMenu();
          void selectTableInSplit(name);
        }}>{$t("contextMenu.openInNewSplit")}</button
      >
      <button
        onclick={() => requestRenameTable(menu.table!)}
        >{$t("contextMenu.rename")}</button
      >
      <button
        class="danger"
        onclick={() => {
          const name = menu.table!;
          closeContextMenu();
          void requestDeleteTable(name);
        }}>{$t("contextMenu.delete")}</button
      >
    {:else}
      {#if !menu.isDir}
        <button
          onclick={() => {
            selectNote(menu.path);
            closeContextMenu();
          }}>{$t("contextMenu.open")}</button
        >
        <button
          onclick={() => {
            const path = menu.path;
            closeContextMenu();
            void selectNoteInSplit(path);
          }}>{$t("contextMenu.openInNewSplit")}</button
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
