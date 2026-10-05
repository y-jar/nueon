<script lang="ts">
  import { t } from "svelte-i18n";
  import { Search } from "@lucide/svelte";
  import {
    ui,
    createNote,
    createFolder,
    selectTable,
    renamePath,
    consumeNew,
    openContextMenu,
  } from "../lib/state.svelte";
  import { filterTree } from "../lib/explorer";
  import ExplorerTree from "./ExplorerTree.svelte";

  let newName = $state("");
  let newKind = $state<"note" | "folder" | null>(null);
  let newBase = $state("");
  let filter = $state("");
  let error = $state("");

  const visibleTree = $derived(filterTree(ui.tree, filter));

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
  </div>

  <label class="explorer-filter">
    <Search size={13} />
    <input
      placeholder={$t("explorer.filter")}
      bind:value={filter}
    />
  </label>

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
      openContextMenu(e.clientX, e.clientY, "", true, "root");
    }}
  >
    {#if visibleTree.length}
      <ExplorerTree nodes={visibleTree} depth={0} />
    {:else if filter}
      <p class="muted">{$t("explorer.noMatches")}</p>
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
</aside>
