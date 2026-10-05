<script lang="ts">
  import { autofocus } from "../lib/actions";
  import { t } from "svelte-i18n";
  import { Table2, Plus, Pencil, Trash2, Search } from "@lucide/svelte";
  import * as api from "../lib/api";
  import {
    ui,
    activeDoc,
    refreshTables,
    selectTable,
    renameTable,
    deleteTable,
  } from "../lib/state.svelte";

  let newOpen = $state(false);
  let newName = $state("");
  let filter = $state("");
  let editing = $state<string | null>(null);
  let editName = $state("");
  let pendingDelete = $state<string | null>(null);
  let error = $state("");

  const visible = $derived(
    ui.tables.filter((table) =>
      table.name.toLowerCase().includes(filter.trim().toLowerCase()),
    ),
  );

  async function create() {
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await api.createTable(name);
      if (!created) {
        error = $t("tables.exists");
        return;
      }
      newName = "";
      newOpen = false;
      error = "";
      await refreshTables();
      await selectTable(name);
    } catch (e) {
      error = String(e);
    }
  }

  async function commitRename() {
    if (!editing) return;
    const name = editName.trim();
    const from = editing;
    editing = null;
    if (!name || name === from) return;
    try {
      await renameTable(from, name);
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const name = pendingDelete;
    pendingDelete = null;
    try {
      await deleteTable(name);
      error = "";
    } catch (e) {
      error = String(e);
    }
  }
</script>

<aside class="sidebar">
  <div class="pane-head">
    <span class="pane-title">{$t("sidebar.tables")}</span>
    <span class="actions">
      <button
        title={$t("tables.newTable")}
        onclick={() => {
          newOpen = true;
          newName = "";
        }}
      >
        <Plus size={14} />
      </button>
    </span>
  </div>

  {#if newOpen}
    <div class="row">
      <input
        use:autofocus
        class="new-input"
        placeholder={$t("tables.namePlaceholder")}
        bind:value={newName}
        onkeydown={(e) => {
          if (e.key === "Enter") create();
          if (e.key === "Escape") newOpen = false;
        }}
      />
      <button onclick={create}>{$t("tables.create")}</button>
    </div>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}

  {#if ui.tables.length > 3}
    <label class="explorer-filter">
      <Search size={13} />
      <input placeholder={$t("tables.filter")} bind:value={filter} />
    </label>
  {/if}

  <div class="table-list">
    {#each visible as table (table.name)}
      <div class="table-row" class:active={activeDoc().currentTable === table.name}>
        {#if editing === table.name}
          <input
            use:autofocus={{ select: true }}
            class="new-input"
            bind:value={editName}
            onkeydown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") editing = null;
            }}
            onblur={commitRename}
          />
        {:else}
          <button
            class="tree-name"
            onclick={() => selectTable(table.name)}
            ondblclick={() => {
              editing = table.name;
              editName = table.name;
            }}
          >
            <Table2 size={14} />
            <span class="grow">{table.name}</span>
            <span class="muted">{table.word_count}</span>
          </button>
          <button
            class="row-action"
            title={$t("tables.rename")}
            onclick={() => {
              editing = table.name;
              editName = table.name;
            }}
          >
            <Pencil size={13} />
          </button>
          <button
            class="row-action"
            title={$t("tables.delete")}
            onclick={() => (pendingDelete = table.name)}
          >
            <Trash2 size={13} />
          </button>
        {/if}
      </div>
    {:else}
      <p class="muted">
        {filter ? $t("tables.noMatches") : $t("tables.empty")}
      </p>
    {/each}
  </div>

  {#if pendingDelete}
    <div class="warn-panel">
      <p class="error">
        {$t("tables.deleteConfirm", { values: { name: pendingDelete } })}
      </p>
      <div class="row">
        <button onclick={confirmDelete}>{$t("tables.delete")}</button>
        <button onclick={() => (pendingDelete = null)}
          >{$t("grid.cancel")}</button
        >
      </div>
    </div>
  {/if}

  <button class="wide" onclick={() => (newOpen = true)}>
    <Plus size={14} /> {$t("tables.newTable")}
  </button>
</aside>
