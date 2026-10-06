<script lang="ts">
  import { autofocus } from "../lib/actions";
  import { t } from "svelte-i18n";
  import { Search, FilePlus, FolderPlus, Trash2 } from "@lucide/svelte";
  import {
    ui,
    createNote,
    createFolder,
    movePath,
    activeDoc,
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

  /** Folder the toolbar buttons create in: the open note's folder. */
  function currentFolder(): string {
    const selected = activeDoc().selected;
    return selected ? selected.split("/").slice(0, -1).join("/") : "";
  }

  function startNew(kind: "note" | "folder") {
    newKind = kind;
    newBase = currentFolder();
    newName = "";
  }

  function onRootDragOver(event: DragEvent) {
    if (ui.dragPath) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
  }

  async function onRootDrop(event: DragEvent) {
    event.preventDefault();
    const src = ui.dragPath;
    ui.dragPath = null;
    if (src) await movePath(src, "");
  }

  /** Right-clicking empty sidebar space opens the root menu. */
  function onSidebarContext(event: MouseEvent) {
    if ((event.target as HTMLElement).closest("input, textarea")) return;
    event.preventDefault();
    openContextMenu(event.clientX, event.clientY, "", true, "root");
  }
</script>

<aside class="sidebar" oncontextmenu={onSidebarContext}>
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

  <div class="explorer-actions">
    <button
      title={$t("sidebar.newNoteTooltip")}
      aria-label={$t("sidebar.newNoteTooltip")}
      onclick={() => startNew("note")}
    >
      <FilePlus size={15} />
    </button>
    <button
      title={$t("sidebar.newFolderTooltip")}
      aria-label={$t("sidebar.newFolderTooltip")}
      onclick={() => startNew("folder")}
    >
      <FolderPlus size={15} />
    </button>
    <span class="grow"></span>
    <button
      title={$t("trash.open")}
      aria-label={$t("trash.open")}
      onclick={() => (ui.trashOpen = true)}
    >
      <Trash2 size={15} />
    </button>
  </div>

  {#if newKind}
    <input
      use:autofocus
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
  >
    {#if visibleTree.length}
      <ExplorerTree nodes={visibleTree} depth={0} />
    {:else if filter}
      <p class="muted">{$t("explorer.noMatches")}</p>
    {:else}
      <p class="muted">{$t("sidebar.noNotes")}</p>
    {/if}
  </div>
</aside>
