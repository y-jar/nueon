<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    createTable,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type ColumnDef,
    type SortingState,
  } from "@tanstack/table-core";
  import * as api from "../lib/api";
  import { boolValue, displayValue, textValue } from "../lib/dictionary";
  import { ui, selectEntry, selectTable } from "../lib/state.svelte";

  let sorting = $state<SortingState>([{ id: "wordname", desc: false }]);
  let filter = $state("");
  let newWord = $state("");
  let newTable = $state("");
  let error = $state("");

  // Dynamic columns are derived from the table's tag set. New tags appear
  // without disturbing sorting/selection (TanStack keeps state by id).
  const tagColumns = $derived(
    (ui.table?.tags ?? []).filter(
      (tag) => tag.name !== "wordname" && tag.name !== "parent",
    ),
  );

  const columns = $derived<ColumnDef<api.WordEntry, string>[]>([
    { id: "wordname", accessorFn: (row) => row.wordname, header: "wordname" },
    { id: "parent", accessorFn: (row) => parentNames(row), header: "parent" },
    ...tagColumns.map((tag) => ({
      id: tag.name,
      accessorFn: (row: api.WordEntry) => displayValue(row.values[tag.name]),
      header: tag.name,
    })),
  ]);

  const table = $derived.by(() =>
    createTable<api.WordEntry>({
      data: ui.table?.entries ?? [],
      columns,
      state: { sorting, globalFilter: filter },
      onStateChange: () => {},
      renderFallbackValue: null,
      onSortingChange: (updater) => {
        sorting = typeof updater === "function" ? updater(sorting) : updater;
      },
      onGlobalFilterChange: (updater) => {
        filter = typeof updater === "function" ? updater(filter) : updater;
      },
      // Stable UUID row keys preserve selection/editing across refetches.
      getRowId: (row) => row.id,
      getCoreRowModel: getCoreRowModel(),
      getSortedRowModel: getSortedRowModel(),
      getFilteredRowModel: getFilteredRowModel(),
      globalFilterFn: (row, _columnId, value) => {
        const needle = String(value ?? "").toLowerCase();
        if (!needle) return true;
        if (row.original.wordname.toLowerCase().includes(needle)) return true;
        return Object.values(row.original.values).some((v) =>
          displayValue(v).toLowerCase().includes(needle),
        );
      },
    }),
  );

  function parentNames(entry: api.WordEntry): string {
    const value = entry.values["parent"];
    if (!value) return "";
    if (value.type === "references") {
      return value.value.map((id) => ui.nameById[id] ?? "?").join(", ");
    }
    if (value.type === "reference") return ui.nameById[value.value] ?? "?";
    return "";
  }

  async function createNewWord() {
    const name = newWord.trim();
    if (!name || !ui.currentTable) return;
    try {
      await api.createWord(ui.currentTable, name);
      newWord = "";
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function createNewTable() {
    const name = newTable.trim();
    if (!name) return;
    try {
      await api.createTable(name);
      newTable = "";
      await selectTable(name);
    } catch (e) {
      error = String(e);
    }
  }

  async function commitWordname(entry: api.WordEntry, value: string) {
    const next = value.trim();
    if (!next || next === entry.wordname || !ui.currentTable) return;
    await api.saveWordEntry(ui.currentTable, { ...entry, wordname: next });
  }

  async function commitText(entry: api.WordEntry, tag: string, value: string) {
    if (!ui.currentTable) return;
    const values = {
      ...entry.values,
      [tag]: { type: "text" as const, value },
    };
    await api.saveWordEntry(ui.currentTable, { ...entry, values });
  }

  async function commitBool(entry: api.WordEntry, tag: string, value: boolean) {
    if (!ui.currentTable) return;
    const values = {
      ...entry.values,
      [tag]: { type: "boolean" as const, value },
    };
    await api.saveWordEntry(ui.currentTable, { ...entry, values });
  }

  async function removeWord(entry: api.WordEntry) {
    if (!ui.currentTable) return;
    await api.deleteWord(ui.currentTable, entry.id);
  }
</script>

<div class="grid-view">
  <div class="grid-toolbar">
    <select
      value={ui.currentTable ?? ""}
      onchange={(e) => selectTable(e.currentTarget.value)}
    >
      {#each ui.tables as t (t.name)}
        <option value={t.name}>{t.name} ({t.word_count})</option>
      {/each}
    </select>
    <input placeholder={$t("grid.newTable")} bind:value={newTable} onkeydown={(e) =>
      e.key === "Enter" && createNewTable()} />
    <input class="filter" placeholder={$t("grid.search")} bind:value={filter} />
    <input placeholder={$t("grid.newWord")} bind:value={newWord} onkeydown={(e) =>
      e.key === "Enter" && createNewWord()} />
    <button onclick={createNewWord}>{$t("grid.addWord")}</button>
  </div>

  {#if error}<p class="error">{error}</p>{/if}

  <div class="grid-scroll">
    <table class="dict-grid">
      <thead>
        {#each table.getHeaderGroups() as group (group.id)}
          <tr>
            {#each group.headers as header (header.id)}
              <th onclick={header.column.getToggleSortingHandler()}>
                {header.column.id}
                {header.column.getIsSorted() === "asc"
                  ? " ▲"
                  : header.column.getIsSorted() === "desc"
                    ? " ▼"
                    : ""}
              </th>
            {/each}
            <th></th>
          </tr>
        {/each}
      </thead>
      <tbody>
        {#each table.getRowModel().rows as row (row.id)}
          <tr
            class:selected={ui.selectedEntry === row.original.id}
            onclick={() => selectEntry(row.original.id)}
          >
            <td>
              <input
                value={row.original.wordname}
                onclick={(e) => e.stopPropagation()}
                onblur={(e) => commitWordname(row.original, e.currentTarget.value)}
              />
            </td>
            <td>{parentNames(row.original) || "—"}</td>
            {#each tagColumns as tag (tag.name)}
              <td onclick={(e) => e.stopPropagation()}>
                {#if tag.kind === "text"}
                  <input
                    value={textValue(row.original.values[tag.name])}
                    onblur={(e) =>
                      commitText(row.original, tag.name, e.currentTarget.value)}
                  />
                {:else if tag.kind === "boolean"}
                  <input
                    type="checkbox"
                    checked={boolValue(row.original.values[tag.name])}
                    onchange={(e) =>
                      commitBool(row.original, tag.name, e.currentTarget.checked)}
                  />
                {:else}
                  {displayValue(row.original.values[tag.name]) || "—"}
                {/if}
              </td>
            {/each}
            <td>
              <button
                onclick={(e) => {
                  e.stopPropagation();
                  removeWord(row.original);
                }}>✕</button
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
