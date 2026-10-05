<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    createTable,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type ColumnDef,
    type ColumnFiltersState,
    type SortingState,
    type VisibilityState,
  } from "@tanstack/table-core";
  import * as api from "../lib/api";
  import {
    boolValue,
    displayValue,
    listValue,
    parseList,
    textValue,
  } from "../lib/dictionary";
  import { misspelledWords } from "../lib/spellcheck";
  import {
    ui,
    refreshTable,
    selectEntry,
    selectTable,
  } from "../lib/state.svelte";

  let sorting = $state<SortingState>([{ id: "wordname", desc: false }]);
  let filter = $state("");
  let columnFilters = $state<ColumnFiltersState>([]);
  let columnVisibility = $state<VisibilityState>({});
  let newWord = $state("");
  let newTable = $state("");
  let error = $state("");
  let loadedTable: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  let selectedIds = $state<string[]>([]);
  let newTagName = $state("");
  let newTagKind = $state("text");
  let knownTags = $state<string[]>([]);
  let tagError = $state("");
  let spellingIssue = $state<{ word: string; words: string[] } | null>(null);
  let pendingRemove = $state<{ tag: string; affected: number } | null>(null);
  let warnDismissed = $state(false);
  let dontWarnAgain = $state(false);

  const KINDS: api.FieldType[] = [
    "text",
    "boolean",
    "tag_list",
    "reference",
    "references",
  ];
  const FORMATS: api.TagFormat[] = [
    "default",
    "multiline",
    "date",
    "measurement",
  ];

  // Dynamic columns are derived from the table's tag set. New tags appear
  // without disturbing sorting/selection (TanStack keeps state by id).
  const tagColumns = $derived(
    (ui.table?.tags ?? []).filter(
      (tag) => tag.name !== "wordname" && tag.name !== "parent",
    ),
  );

  const columns = $derived<ColumnDef<api.WordEntry, string>[]>([
    {
      id: "wordname",
      accessorFn: (row) => row.wordname,
      header: "wordname",
      filterFn: "includesString",
      enableHiding: false,
    },
    {
      id: "parent",
      accessorFn: (row) => parentNames(row),
      header: "parent",
      filterFn: "includesString",
    },
    ...tagColumns.map((tag) => ({
      id: tag.name,
      accessorFn: (row: api.WordEntry) => displayValue(row.values[tag.name]),
      header: tag.name,
      filterFn: "includesString" as const,
    })),
  ]);

  const table = $derived.by(() =>
    createTable<api.WordEntry>({
      data: ui.table?.entries ?? [],
      columns,
      state: { sorting, globalFilter: filter, columnFilters, columnVisibility },
      onStateChange: () => {},
      renderFallbackValue: null,
      onSortingChange: (updater) => {
        sorting = typeof updater === "function" ? updater(sorting) : updater;
      },
      onGlobalFilterChange: (updater) => {
        filter = typeof updater === "function" ? updater(filter) : updater;
      },
      onColumnFiltersChange: (updater) => {
        columnFilters =
          typeof updater === "function" ? updater(columnFilters) : updater;
      },
      onColumnVisibilityChange: (updater) => {
        columnVisibility =
          typeof updater === "function" ? updater(columnVisibility) : updater;
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

  const rows = $derived(table.getRowModel().rows);

  // Load persisted view state when the active table changes.
  $effect(() => {
    const name = ui.currentTable;
    if (!name || name === loadedTable) return;
    api
      .gridViewGet(name)
      .then((view) => {
        if (ui.currentTable !== name) return;
        sorting = view.sorting.length
          ? view.sorting.map((spec) => ({ id: spec.id, desc: spec.desc }))
          : [{ id: "wordname", desc: false }];
        filter = view.search;
        columnFilters = Object.entries(view.column_filters).map(
          ([id, value]) => ({ id, value }),
        );
        columnVisibility = Object.fromEntries(
          view.hidden_columns.map((id) => [id, false]),
        );
        selectedIds = [];
        loadedTable = name;
      })
      .catch(() => {
        loadedTable = name;
      });
  });

  // Persist view state (debounced) whenever the grid presentation changes.
  $effect(() => {
    const name = ui.currentTable;
    const snapshot: api.GridViewState = {
      sorting: sorting.map((spec) => ({ id: spec.id, desc: spec.desc })),
      search: filter,
      column_filters: Object.fromEntries(
        columnFilters.map((entry) => [entry.id, String(entry.value)]),
      ),
      hidden_columns: Object.entries(columnVisibility)
        .filter(([, visible]) => !visible)
        .map(([id]) => id),
    };
    if (!name || name !== loadedTable) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api.gridViewSet(name, snapshot).catch(() => {}), 400);
  });

  $effect(() => {
    if (ui.root) {
      api.knownTagNames().then((names) => (knownTags = names)).catch(() => {});
      api
        .warningDismissed("remove-tag")
        .then((value) => (warnDismissed = value))
        .catch(() => {});
    } else {
      knownTags = [];
    }
  });

  function parentNames(entry: api.WordEntry): string {
    const value = entry.values["parent"];
    if (!value) return "";
    if (value.type === "references") {
      return value.value.map((id) => ui.nameById[id] ?? "?").join(", ");
    }
    if (value.type === "reference") return ui.nameById[value.value] ?? "?";
    return "";
  }

  function columnFilter(id: string): string {
    return String(
      columnFilters.find((entry) => entry.id === id)?.value ?? "",
    );
  }

  function setColumnFilter(id: string, value: string) {
    const rest = columnFilters.filter((entry) => entry.id !== id);
    columnFilters = value ? [...rest, { id, value }] : rest;
  }

  function toggleColumn(id: string, visible: boolean) {
    columnVisibility = { ...columnVisibility, [id]: visible };
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

  async function commitList(entry: api.WordEntry, tag: string, value: string) {
    if (!ui.currentTable) return;
    const values = { ...entry.values };
    const items = parseList(value);
    if (items.length) values[tag] = { type: "tag_list", value: items };
    else delete values[tag];
    await api.saveWordEntry(ui.currentTable, { ...entry, values });
    if (tag === "definition") {
      const words = await misspelledWords(value);
      spellingIssue = words.length
        ? { word: entry.wordname, words }
        : spellingIssue?.word === entry.wordname
          ? null
          : spellingIssue;
    }
  }

  async function removeWord(entry: api.WordEntry) {
    if (!ui.currentTable) return;
    await api.deleteWord(ui.currentTable, entry.id);
  }

  function toggleSelected(id: string, checked: boolean) {
    selectedIds = checked
      ? [...selectedIds, id]
      : selectedIds.filter((candidate) => candidate !== id);
  }

  function toggleAll(checked: boolean) {
    selectedIds = checked ? rows.map((row) => row.original.id) : [];
  }

  async function deleteSelected() {
    if (!ui.currentTable || selectedIds.length === 0) return;
    for (const id of selectedIds) {
      await api.deleteWord(ui.currentTable, id);
    }
    selectedIds = [];
  }

  async function addTag() {
    const name = newTagName.trim();
    if (!name || !ui.currentTable) return;
    try {
      const added = await api.addTag(
        ui.currentTable,
        name,
        newTagKind as api.FieldType,
      );
      if (!added) {
        tagError = $t("grid.tagExists");
        return;
      }
      newTagName = "";
      tagError = "";
      await refreshTable();
    } catch (e) {
      tagError = String(e);
    }
  }

  async function removeTag(name: string) {
    if (!ui.currentTable) return;
    const affected = await api.removeTagPreview(ui.currentTable, name);
    if (warnDismissed) {
      await api.removeTag(ui.currentTable, name);
      await refreshTable();
      return;
    }
    dontWarnAgain = false;
    pendingRemove = { tag: name, affected };
  }

  async function confirmRemove() {
    if (!pendingRemove || !ui.currentTable) return;
    if (dontWarnAgain) {
      await api.dismissWarning("remove-tag");
      warnDismissed = true;
    }
    await api.removeTag(ui.currentTable, pendingRemove.tag);
    pendingRemove = null;
    await refreshTable();
  }

  async function changeKind(name: string, kind: api.FieldType) {
    if (!ui.currentTable) return;
    await api.setTagKind(ui.currentTable, name, kind);
    await refreshTable();
  }

  async function changeFormat(name: string, format: api.TagFormat) {
    if (!ui.currentTable) return;
    await api.setTagFormat(ui.currentTable, name, format);
    await refreshTable();
  }

  async function doUndo() {
    await api.undo();
    await refreshTable();
  }

  async function doRedo() {
    await api.redo();
    await refreshTable();
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
    <button title={$t("grid.undo")} onclick={doUndo}>↶</button>
    <button title={$t("grid.redo")} onclick={doRedo}>↷</button>

    <details class="col-picker">
      <summary>{$t("grid.columns")}</summary>
      <div class="picker-body">
        {#each table.getAllLeafColumns() as column (column.id)}
          <label class="picker-row">
            <input
              type="checkbox"
              checked={column.getIsVisible()}
              disabled={!column.getCanHide()}
              onchange={(e) =>
                toggleColumn(column.id, e.currentTarget.checked)}
            />
            {column.id}
          </label>
        {/each}
      </div>
    </details>

    <details class="col-picker">
      <summary>{$t("grid.tags")}</summary>
      <div class="picker-body">
        {#each tagColumns as tag (tag.name)}
          <div class="tag-row">
            <span>{tag.name}</span>
            {#if tag.name === "definition"}
              <span class="muted">{tag.kind}</span>
            {:else}
              <select
                value={tag.kind}
                onchange={(e) =>
                  changeKind(tag.name, e.currentTarget.value as api.FieldType)}
              >
                {#each KINDS as kind (kind)}
                  <option value={kind}>{kind}</option>
                {/each}
              </select>
              <select
                value={tag.format ?? "default"}
                onchange={(e) =>
                  changeFormat(
                    tag.name,
                    e.currentTarget.value as api.TagFormat,
                  )}
              >
                {#each FORMATS as format (format)}
                  <option value={format}>{format}</option>
                {/each}
              </select>
              <button
                title={$t("grid.removeTag")}
                onclick={() => removeTag(tag.name)}>✕</button
              >
            {/if}
          </div>
        {/each}
        <div class="tag-row">
          <input
            placeholder={$t("grid.newTag")}
            bind:value={newTagName}
            list="known-tags"
            onkeydown={(e) => e.key === "Enter" && addTag()}
          />
          <datalist id="known-tags">
            {#each knownTags as name (name)}
              <option value={name}></option>
            {/each}
          </datalist>
          <select bind:value={newTagKind}>
            {#each KINDS as kind (kind)}
              <option value={kind}>{kind}</option>
            {/each}
          </select>
          <button onclick={addTag}>{$t("grid.add")}</button>
        </div>
        {#if tagError}<p class="error">{tagError}</p>{/if}
      </div>
    </details>

    {#if selectedIds.length}
      <span class="muted"
        >{$t("grid.selected", { values: { count: selectedIds.length } })}</span
      >
      <button onclick={deleteSelected}>{$t("grid.deleteSelected")}</button>
    {/if}
  </div>

  {#if error}<p class="error">{error}</p>{/if}
  {#if spellingIssue}
    <p class="error">
      {$t("grid.spelling", {
        values: {
          word: spellingIssue.word,
          words: spellingIssue.words.join(", "),
        },
      })}
      <button onclick={() => (spellingIssue = null)}>✕</button>
    </p>
  {/if}
  {#if pendingRemove}
    <div class="warn-panel">
      <p class="error">
        {$t("grid.removeTagConfirm", {
          values: { tag: pendingRemove.tag, count: pendingRemove.affected },
        })}
      </p>
      <label class="muted">
        <input type="checkbox" bind:checked={dontWarnAgain} />
        {$t("grid.dontShowAgain")}
      </label>
      <div class="row">
        <button onclick={confirmRemove}>{$t("grid.removeTag")}</button>
        <button onclick={() => (pendingRemove = null)}>{$t("grid.cancel")}</button>
      </div>
    </div>
  {/if}

  <div class="grid-scroll">
    <table class="dict-grid">
      <thead>
        {#each table.getHeaderGroups() as group (group.id)}
          <tr>
            <th class="select-col">
              <input
                type="checkbox"
                checked={rows.length > 0 &&
                  selectedIds.length === rows.length}
                onchange={(e) => toggleAll(e.currentTarget.checked)}
              />
            </th>
            {#each group.headers as header (header.id)}
              <th>
                <button
                  class="sort"
                  onclick={header.column.getToggleSortingHandler()}
                >
                  {header.column.id}
                  {header.column.getIsSorted() === "asc"
                    ? " ▲"
                    : header.column.getIsSorted() === "desc"
                      ? " ▼"
                      : ""}
                </button>
              </th>
            {/each}
            <th></th>
          </tr>
          <tr>
            <th class="select-col"></th>
            {#each group.headers as header (header.id)}
              <th>
                <input
                  class="col-filter"
                  value={columnFilter(header.column.id)}
                  oninput={(e) =>
                    setColumnFilter(header.column.id, e.currentTarget.value)}
                  onclick={(e) => e.stopPropagation()}
                />
              </th>
            {/each}
            <th></th>
          </tr>
        {/each}
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr
            class:selected={ui.selectedEntry === row.original.id}
            onclick={() => selectEntry(row.original.id)}
          >
            <td class="select-col" onclick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={selectedIds.includes(row.original.id)}
                onchange={(e) =>
                  toggleSelected(row.original.id, e.currentTarget.checked)}
              />
            </td>
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
                  {#if tag.format === "multiline"}
                    <textarea
                      rows="2"
                      value={textValue(row.original.values[tag.name])}
                      onblur={(e) =>
                        commitText(
                          row.original,
                          tag.name,
                          e.currentTarget.value,
                        )}
                    ></textarea>
                  {:else}
                    <input
                      type={tag.format === "date"
                        ? "date"
                        : tag.format === "measurement"
                          ? "number"
                          : "text"}
                      value={textValue(row.original.values[tag.name])}
                      onblur={(e) =>
                        commitText(
                          row.original,
                          tag.name,
                          e.currentTarget.value,
                        )}
                    />
                  {/if}
                {:else if tag.kind === "boolean"}
                  <input
                    type="checkbox"
                    checked={boolValue(row.original.values[tag.name])}
                    onchange={(e) =>
                      commitBool(row.original, tag.name, e.currentTarget.checked)}
                  />
                {:else if tag.kind === "tag_list"}
                  <input
                    value={listValue(row.original.values[tag.name])}
                    onblur={(e) =>
                      commitList(row.original, tag.name, e.currentTarget.value)}
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
