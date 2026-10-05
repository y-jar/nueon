<script lang="ts">
  import { t } from "svelte-i18n";
  import { Table2, Plus } from "@lucide/svelte";
  import * as api from "../lib/api";
  import { ui, refreshTables, selectTable } from "../lib/state.svelte";

  let newOpen = $state(false);
  let newName = $state("");
  let error = $state("");

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

  <div class="table-list">
    {#each ui.tables as table (table.name)}
      <button
        class="tree-name {ui.currentTable === table.name ? 'selected' : ''}"
        onclick={() => selectTable(table.name)}
      >
        <Table2 size={14} />
        <span class="grow">{table.name}</span>
        <span class="muted">{table.word_count}</span>
      </button>
    {:else}
      <p class="muted">{$t("tables.empty")}</p>
    {/each}
  </div>

  <button class="wide" onclick={() => (newOpen = true)}>
    <Plus size={14} /> {$t("tables.newTable")}
  </button>
</aside>
