<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    ui,
    openWorkspace,
    createNote,
    createFolder,
    selectTable,
    renamePath,
    consumeNew,
    openContextMenu,
  } from "../lib/state.svelte";
  import Tree from "./Tree.svelte";

  let newName = $state("");
  let newKind = $state<"note" | "folder" | null>(null);
  let newBase = $state("");
  let wsMenu = $state(false);
  let error = $state("");

  // Context-menu "new note/folder here" requests.
  $effect(() => {
    const request = ui.newRequest;
    if (request) {
      newKind = request.kind;
      newBase = request.base;
      newName = "";
      consumeNew();
    }
  });

  async function submitNew() {
    const name = newName.trim();
    if (!name) {
      newKind = null;
      return;
    }
    const target = newBase ? `${newBase}/${name}` : name;
    error = "";
    try {
      if (newKind === "note") await createNote(target);
      else await createFolder(target);
    } catch (e) {
      error = String(e);
    } finally {
      newName = "";
      newKind = null;
    }
  }

  function onRootDragOver(event: DragEvent) {
    if (ui.dragPath) {
      event.preventDefault();
    }
  }

  async function onRootDrop(event: DragEvent) {
    event.preventDefault();
    const src = ui.dragPath;
    ui.dragPath = null;
    if (!src) return;
    const name = src.split("/").pop() ?? src;
    if (name === src) return;
    await renamePath(src, name);
  }
</script>

<aside class="sidebar">
  <div class="pane-head">
    <span class="pane-title">{$t("sidebar.notes")}</span>
    <span class="actions">
      <button
        title={$t("sidebar.newNoteTooltip")}
        onclick={() => {
          newKind = "note";
          newName = "";
        }}>{$t("sidebar.noteButton")}</button
      >
      <button
        title={$t("sidebar.newFolderTooltip")}
        onclick={() => {
          newKind = "folder";
          newName = "";
        }}>{$t("sidebar.folderButton")}</button
      >
    </span>
  </div>

  {#if newKind}
    <input
      class="new-input"
      placeholder={newKind === "note"
        ? $t("sidebar.notePathPlaceholder")
        : $t("sidebar.folderPathPlaceholder")}
      bind:value={newName}
      onkeydown={(e) => {
        if (e.key === "Enter") submitNew();
        if (e.key === "Escape") newKind = null;
      }}
    />
  {/if}
  {#if error}<p class="error">{error}</p>{/if}

  <div
    class="tree"
    role="tree"
    tabindex="-1"
    ondragover={onRootDragOver}
    ondrop={onRootDrop}
    oncontextmenu={(e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, "", true);
    }}
  >
    {#if ui.tree.length}
      <Tree nodes={ui.tree} depth={0} />
    {:else}
      <p class="muted">{$t("sidebar.noNotes")}</p>
    {/if}
  </div>

  <div class="pane-title">{$t("sidebar.tables")}</div>
  {#each ui.tables as table (table.name)}
    <button
      class="tree-name {ui.currentTable === table.name ? 'selected' : ''}"
      onclick={() => selectTable(table.name)}
      >{table.name} ({table.word_count})</button
    >
  {/each}

  <div class="grow"></div>

  <div class="switcher">
    <span class="pane-title">{$t("sidebar.workspace")}</span>
    <button class="ws-button" onclick={() => (wsMenu = !wsMenu)}>
      {ui.root ?? $t("sidebar.openWorkspace")}
    </button>
    {#if wsMenu}
      <ul class="ws-menu">
        {#each ui.workspaces as ws (ws.path)}
          <li>
            <button
              onclick={() => {
                wsMenu = false;
                openWorkspace(ws.path);
              }}>{ws.name || ws.path}</button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</aside>
