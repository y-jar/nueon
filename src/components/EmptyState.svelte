<!-- Empty pane: new note/table shortcuts. -->
<script lang="ts">
  import { autofocus } from "../lib/actions";
  import { t } from "svelte-i18n";
  import {
    FilePlus,
    Table2,
    Languages,
    NotebookPen,
    Plus,
  } from "@lucide/svelte";
  import * as api from "../lib/api";
  import {
    ui,
    createNote,
    setActivity,
    refreshTables,
    selectTable,
  } from "../lib/state.svelte";

  let newTableName = $state("");
  let error = $state("");

  const noTables = $derived(ui.tables.length === 0);

  async function newNote() {
    error = "";
    try {
      await createNote();
    } catch (e) {
      error = String(e);
    }
  }

  async function createFirstTable() {
    const name = newTableName.trim();
    if (!name) return;
    try {
      const created = await api.createTable(name);
      if (!created) {
        error = $t("tables.exists");
        return;
      }
      newTableName = "";
      error = "";
      await refreshTables();
      await selectTable(name);
    } catch (e) {
      error = String(e);
    }
  }
</script>

<div class="center-empty">
  {#if ui.activity === "dictionary"}
    <Table2 size={44} />
    {#if noTables}
      <h2>{$t("wizard.firstTableTitle")}</h2>
      <p class="muted">{$t("wizard.firstTableHint")}</p>
      <div class="row">
        <input
          use:autofocus
          placeholder={$t("tables.namePlaceholder")}
          bind:value={newTableName}
          onkeydown={(e) => e.key === "Enter" && createFirstTable()}
        />
        <button onclick={createFirstTable}>
          <Plus size={15} /> {$t("tables.create")}
        </button>
      </div>
    {:else}
      <h2>{$t("wizard.pickTableTitle")}</h2>
      <p class="muted">{$t("wizard.pickTableHint")}</p>
    {/if}
  {:else}
    <NotebookPen size={44} />
    <h2>{$t("tabs.emptyTitle")}</h2>
    <p class="muted">{$t("tabs.emptyHint")}</p>
    <div class="row">
      <button onclick={newNote}>
        <FilePlus size={15} /> {$t("tabs.newNote")}
      </button>
      <button onclick={() => setActivity("dictionary")}>
        <Table2 size={15} /> {$t("activity.dictionary")}
      </button>
      <button onclick={() => setActivity("translation")}>
        <Languages size={15} /> {$t("activity.translation")}
      </button>
    </div>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
</div>
