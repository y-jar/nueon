<script lang="ts">
  import {
    ui,
    openWorkspace,
    createNote,
    createFolder,
    selectTable,
  } from "../lib/state.svelte";
  import Tree from "./Tree.svelte";

  let newName = $state("");
  let newKind = $state<"note" | "folder" | null>(null);
  let wsMenu = $state(false);
  let error = $state("");

  async function submitNew() {
    const name = newName.trim();
    if (!name) {
      newKind = null;
      return;
    }
    error = "";
    try {
      if (newKind === "note") await createNote(name);
      else await createFolder(name);
    } catch (e) {
      error = String(e);
    } finally {
      newName = "";
      newKind = null;
    }
  }
</script>

<aside class="sidebar">
  <div class="pane-head">
    <span class="pane-title">Notes</span>
    <span class="actions">
      <button
        title="New note"
        onclick={() => {
          newKind = "note";
          newName = "";
        }}>＋note</button
      >
      <button
        title="New folder"
        onclick={() => {
          newKind = "folder";
          newName = "";
        }}>＋dir</button
      >
    </span>
  </div>

  {#if newKind}
    <input
      class="new-input"
      placeholder={newKind === "note" ? "path/to/note" : "path/to/folder"}
      bind:value={newName}
      onkeydown={(e) => {
        if (e.key === "Enter") submitNew();
        if (e.key === "Escape") newKind = null;
      }}
    />
  {/if}
  {#if error}<p class="error">{error}</p>{/if}

  <div class="tree">
    {#if ui.tree.length}
      <Tree nodes={ui.tree} depth={0} />
    {:else}
      <p class="muted">No notes yet.</p>
    {/if}
  </div>

  <div class="pane-title">Tables</div>
  {#each ui.tables as table (table.name)}
    <button
      class="tree-name {ui.currentTable === table.name ? 'selected' : ''}"
      onclick={() => selectTable(table.name)}
      >{table.name} ({table.word_count})</button
    >
  {/each}

  <div class="grow"></div>

  <div class="switcher">
    <span class="pane-title">Workspace</span>
    <button class="ws-button" onclick={() => (wsMenu = !wsMenu)}>
      {ui.root ?? "Open workspace"}
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
