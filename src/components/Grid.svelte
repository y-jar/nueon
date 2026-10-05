<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    createTable,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type ColumnDef,
    type SortingState,
    type VisibilityState,
  } from "@tanstack/table-core";
  import {
    ArrowUpDown,
    Search,
    Plus,
    Columns3,
    Tags,
    Undo2,
    Redo2,
    X,
    Check,
  } from "@lucide/svelte";
  import * as api from "../lib/api";
  import {
    boolValue,
    displayValue,
    textValue,
  } from "../lib/dictionary";
  import { misspelledWords } from "../lib/spellcheck";
  import { ui, selectTable, type DocState } from "../lib/state.svelte";
  import PillCell from "./PillCell.svelte";

  let {
    doc,
    onRefresh,
  }: { doc: DocState; onRefresh: () => void } = $props();

  let sorting = $state<SortingState>([{ id: "wordname", desc: false }]);
  let filter = $state("");
  let columnVisibility = $state<VisibilityState>({});
  let ghostName = $state("");
  let error = $state("");
  let loadedTable: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  let searchOpen = $state(false);
  let addWordOpen = $state(false);
  let addWordName = $state("");
  let addWordError = $state("");

  let selectedIds = $state<string[]>([]);
  let newTagName = $state("");
  let newTagKind = $state("text");
  let knownTags = $state<string[]>([]);
  let tagError = $state("");
  let spellingIssue = $state<{ word: string; words: string[] } | null>(null);
  let pendingRemove = $state<{ tag: string; affected: number } | null>(null);
  let warnDismissed = $state(false);
  let dontWarnAgain = $state(false);

  // Notion-style column types backed by the existing FieldTypes.
  const COLUMN_TYPES: { id: api.FieldType; label: string }[] = [
    { id: "text", label: "Text" },
    { id: "tag_list", label: "List" },
    { id: "references", label: "Relation" },
    { id: "boolean", label: "Checkbox" },
  ];
  const FORMATS: api.TagFormat[] = ["default", "multiline", "date", "measurement"];

  function typeLabel(kind: api.FieldType): string {
    return COLUMN_TYPES.find((type) => type.id === kind)?.label ?? kind;
  }

  const tagColumns = $derived(
    (doc.table?.tags ?? []).filter(
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
      data: doc.table?.entries ?? [],
      columns,
      state: { sorting, globalFilter: filter, columnVisibility },
      onStateChange: () => {},
      renderFallbackValue: null,
      onSortingChange: (updater) => {
        sorting = typeof updater === "function" ? updater(sorting) : updater;
      },
      onGlobalFilterChange: (updater) => {
        filter = typeof updater === "function" ? updater(filter) : updater;
      },
      onColumnVisibilityChange: (updater) => {
        columnVisibility =
          typeof updater === "function" ? updater(columnVisibility) : updater;
      },
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

  const relationOptions = $derived.by(() => {
    const seen = new Map<string, { id: string; label: string }>();
    for (const hits of Object.values(ui.wordIndex)) {
      for (const hit of hits) {
        const label = `${hit.wordname} · ${hit.table}`;
        if (!seen.has(label)) seen.set(label, { id: hit.id, label });
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  });

  // Load persisted view state when the active table changes.
  $effect(() => {
    const name = doc.currentTable;
    if (!name || name === loadedTable) return;
    api
      .gridViewGet(name)
      .then((view) => {
        if (doc.currentTable !== name) return;
        sorting = view.sorting.length
          ? view.sorting.map((spec) => ({ id: spec.id, desc: spec.desc }))
          : [{ id: "wordname", desc: false }];
        filter = view.search;
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
    const name = doc.currentTable;
    const snapshot: api.GridViewState = {
      sorting: sorting.map((spec) => ({ id: spec.id, desc: spec.desc })),
      search: filter,
      column_filters: {},
      hidden_columns: Object.entries(columnVisibility)
        .filter(([, visible]) => !visible)
        .map(([id]) => id),
    };
    if (!name || name !== loadedTable) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(
      () => api.gridViewSet(name, snapshot).catch(() => {}),
      400,
    );
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

  function selectRow(id: string) {
    doc.selectedEntry = doc.selectedEntry === id ? null : id;
  }

  function toggleColumn(id: string, visible: boolean) {
    columnVisibility = { ...columnVisibility, [id]: visible };
  }

  const sortId = $derived(sorting[0]?.id ?? "wordname");
  const sortDesc = $derived(Boolean(sorting[0]?.desc));

  function setSortColumn(id: string) {
    sorting = [{ id, desc: sortDesc }];
  }

  function toggleSortDir() {
    sorting = [{ id: sortId, desc: !sortDesc }];
  }

  async function submitAddWord() {
    const name = addWordName.trim();
    if (!name || !doc.currentTable) return;
    try {
      await api.createWord(doc.currentTable, name);
      addWordName = "";
      addWordOpen = false;
      addWordError = "";
      onRefresh();
    } catch (e) {
      addWordError = String(e);
    }
  }

  async function createGhost() {
    const name = ghostName.trim();
    if (!name || !doc.currentTable) return;
    try {
      await api.createWord(doc.currentTable, name);
      ghostName = "";
      error = "";
      onRefresh();
    } catch (e) {
      error = String(e);
    }
  }

  async function commitWordname(entry: api.WordEntry, value: string) {
    const next = value.trim();
    if (!next || next === entry.wordname || !doc.currentTable) return;
    await api.saveWordEntry(doc.currentTable, { ...entry, wordname: next });
  }

  async function commitText(entry: api.WordEntry, tag: string, value: string) {
    if (!doc.currentTable) return;
    const values = {
      ...entry.values,
      [tag]: { type: "text" as const, value },
    };
    await api.saveWordEntry(doc.currentTable, { ...entry, values });
  }

  async function commitBool(entry: api.WordEntry, tag: string, value: boolean) {
    if (!doc.currentTable) return;
    const values = {
      ...entry.values,
      [tag]: { type: "boolean" as const, value },
    };
    await api.saveWordEntry(doc.currentTable, { ...entry, values });
  }

  function listValues(entry: api.WordEntry, tag: string): string[] {
    const value = entry.values[tag];
    return value && value.type === "tag_list" ? value.value : [];
  }

  function refValues(entry: api.WordEntry, tag: string): string[] {
    const value = entry.values[tag];
    if (!value) return [];
    if (value.type === "references") return value.value;
    if (value.type === "reference") return [value.value];
    return [];
  }

  async function setListValues(
    entry: api.WordEntry,
    tag: string,
    values: string[],
  ) {
    if (!doc.currentTable) return;
    const next = { ...entry.values };
    if (values.length) next[tag] = { type: "tag_list", value: values };
    else delete next[tag];
    await api.saveWordEntry(doc.currentTable, { ...entry, values: next });
    if (tag === "definition") {
      const words = await misspelledWords(values.join(", "));
      spellingIssue = words.length
        ? { word: entry.wordname, words }
        : spellingIssue?.word === entry.wordname
          ? null
          : spellingIssue;
    }
  }

  async function setRefValues(
    entry: api.WordEntry,
    tag: string,
    values: string[],
  ) {
    if (!doc.currentTable) return;
    const next = { ...entry.values };
    if (values.length) next[tag] = { type: "references", value: values };
    else delete next[tag];
    await api.saveWordEntry(doc.currentTable, { ...entry, values: next });
  }

  async function addToList(entry: api.WordEntry, tag: string, text: string) {
    const current = listValues(entry, tag);
    if (current.includes(text)) return;
    await setListValues(entry, tag, [...current, text]);
  }

  async function removeFromList(
    entry: api.WordEntry,
    tag: string,
    id: string,
  ) {
    await setListValues(
      entry,
      tag,
      listValues(entry, tag).filter((item) => item !== id),
    );
  }

  async function addRelation(
    entry: api.WordEntry,
    tag: string,
    label: string,
  ) {
    const option = relationOptions.find((item) => item.label === label);
    if (!option) return;
    const current = refValues(entry, tag);
    if (current.includes(option.id)) return;
    await setRefValues(entry, tag, [...current, option.id]);
  }

  async function removeRelation(
    entry: api.WordEntry,
    tag: string,
    id: string,
  ) {
    await setRefValues(
      entry,
      tag,
      refValues(entry, tag).filter((item) => item !== id),
    );
  }

  async function removeWord(entry: api.WordEntry) {
    if (!doc.currentTable) return;
    await api.deleteWord(doc.currentTable, entry.id);
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
    if (!doc.currentTable || selectedIds.length === 0) return;
    for (const id of selectedIds) {
      await api.deleteWord(doc.currentTable, id);
    }
    selectedIds = [];
  }

  async function addTag() {
    const name = newTagName.trim();
    if (!name || !doc.currentTable) return;
    try {
      const added = await api.addTag(
        doc.currentTable,
        name,
        newTagKind as api.FieldType,
      );
      if (!added) {
        tagError = $t("grid.tagExists");
        return;
      }
      newTagName = "";
      tagError = "";
      onRefresh();
    } catch (e) {
      tagError = String(e);
    }
  }

  async function removeTag(name: string) {
    if (!doc.currentTable) return;
    const affected = await api.removeTagPreview(doc.currentTable, name);
    if (warnDismissed) {
      await api.removeTag(doc.currentTable, name);
      onRefresh();
      return;
    }
    dontWarnAgain = false;
    pendingRemove = { tag: name, affected };
  }

  async function confirmRemove() {
    if (!pendingRemove || !doc.currentTable) return;
    if (dontWarnAgain) {
      await api.dismissWarning("remove-tag");
      warnDismissed = true;
    }
    await api.removeTag(doc.currentTable, pendingRemove.tag);
    pendingRemove = null;
    onRefresh();
  }

  async function changeKind(name: string, kind: api.FieldType) {
    if (!doc.currentTable) return;
    await api.setTagKind(doc.currentTable, name, kind);
    onRefresh();
  }

  async function changeFormat(name: string, format: api.TagFormat) {
    if (!doc.currentTable) return;
    await api.setTagFormat(doc.currentTable, name, format);
    onRefresh();
  }

  async function doUndo() {
    await api.undo();
    onRefresh();
  }

  async function doRedo() {
    await api.redo();
    onRefresh();
  }
</script>

<div class="grid-view">
  <div class="grid-toolbar">
    <select
      class="table-picker"
      value={doc.currentTable ?? ""}
      onchange={(e) => selectTable(e.currentTarget.value)}
    >
      {#each ui.tables as t (t.name)}
        <option value={t.name}>{t.name}</option>
      {/each}
    </select>

    <span class="results-count"
      >{$t("grid.results", { values: { count: rows.length } })}</span
    >

    <details class="popover" id="sort-pop">
      <summary><ArrowUpDown size={14} /> {$t("grid.sort")}</summary>
      <div class="picker-body">
        <label class="picker-row">
          <span class="muted">{$t("grid.sortColumn")}</span>
          <select value={sortId} onchange={(e) => setSortColumn(e.currentTarget.value)}>
            {#each table.getAllLeafColumns() as column (column.id)}
              <option value={column.id}>{column.id}</option>
            {/each}
          </select>
        </label>
        <button onclick={toggleSortDir}>
          {sortDesc ? $t("grid.descending") : $t("grid.ascending")}
        </button>
      </div>
    </details>

    <button
      class="tool-btn"
      class:active={searchOpen}
      title={$t("grid.search")}
      onclick={() => (searchOpen = !searchOpen)}
    >
      <Search size={14} />
    </button>

    <span class="grow"></span>

    <button title={$t("grid.undo")} onclick={doUndo}><Undo2 size={14} /></button>
    <button title={$t("grid.redo")} onclick={doRedo}><Redo2 size={14} /></button>

    <details class="popover">
      <summary><Columns3 size={14} /> {$t("grid.columns")}</summary>
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

    <details class="popover">
      <summary><Tags size={14} /> {$t("grid.tags")}</summary>
      <div class="picker-body">
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
            {#each COLUMN_TYPES as type (type.id)}
              <option value={type.id}>{type.label}</option>
            {/each}
          </select>
          <button onclick={addTag}><Plus size={13} /></button>
        </div>
        {#if tagError}<p class="error">{tagError}</p>{/if}

        {#each tagColumns as tag (tag.name)}
          <div class="tag-row">
            <span class="grow">{tag.name}</span>
            {#if tag.name === "definition"}
              <span class="muted">{typeLabel(tag.kind)}</span>
            {:else}
              <select
                value={tag.kind}
                onchange={(e) =>
                  changeKind(tag.name, e.currentTarget.value as api.FieldType)}
              >
                {#each COLUMN_TYPES as type (type.id)}
                  <option value={type.id}>{type.label}</option>
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
              <button title={$t("grid.removeTag")} onclick={() => removeTag(tag.name)}>
                <X size={13} />
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </details>

    <button class="primary" onclick={() => (addWordOpen = true)}>
      <Plus size={14} /> {$t("grid.addWord")}
    </button>

    {#if selectedIds.length}
      <span class="muted"
        >{$t("grid.selected", { values: { count: selectedIds.length } })}</span
      >
      <button onclick={deleteSelected}>{$t("grid.deleteSelected")}</button>
    {/if}
  </div>

  {#if searchOpen}
    <div class="grid-search">
      <Search size={14} />
      <input placeholder={$t("grid.search")} bind:value={filter} />
    </div>
  {/if}

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
                checked={rows.length > 0 && selectedIds.length === rows.length}
                onchange={(e) => toggleAll(e.currentTarget.checked)}
              />
            </th>
            {#each group.headers as header (header.id)}
              <th class:wordname-col={header.column.id === "wordname"}>
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
        {/each}
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr
            class:selected={doc.selectedEntry === row.original.id}
            onclick={() => selectRow(row.original.id)}
          >
            <td class="select-col" onclick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={selectedIds.includes(row.original.id)}
                onchange={(e) =>
                  toggleSelected(row.original.id, e.currentTarget.checked)}
              />
            </td>
            <td class="wordname-col">
              <input
                value={row.original.wordname}
                onclick={(e) => e.stopPropagation()}
                onblur={(e) => commitWordname(row.original, e.currentTarget.value)}
              />
            </td>
            <td>{parentNames(row.original) || "—"}</td>
            {#each tagColumns as tag (tag.name)}
              <td
                class:editable={tag.kind === "text" ||
                  tag.kind === "tag_list" ||
                  tag.kind === "boolean"}
                onclick={(e) => e.stopPropagation()}
              >
                {#if tag.kind === "text"}
                  {#if tag.format === "multiline"}
                    <textarea
                      rows="2"
                      placeholder="—"
                      value={textValue(row.original.values[tag.name])}
                      onblur={(e) =>
                        commitText(row.original, tag.name, e.currentTarget.value)}
                    ></textarea>
                  {:else}
                    <input
                      type={tag.format === "date"
                        ? "date"
                        : tag.format === "measurement"
                          ? "number"
                          : "text"}
                      placeholder="—"
                      value={textValue(row.original.values[tag.name])}
                      onblur={(e) =>
                        commitText(row.original, tag.name, e.currentTarget.value)}
                    />
                  {/if}
                {:else if tag.kind === "boolean"}
                  <button
                    class="check-cell"
                    class:on={boolValue(row.original.values[tag.name])}
                    onclick={() =>
                      commitBool(
                        row.original,
                        tag.name,
                        !boolValue(row.original.values[tag.name]),
                      )}
                  >
                    {#if boolValue(row.original.values[tag.name])}
                      <Check size={14} />
                    {/if}
                  </button>
                {:else if tag.kind === "tag_list"}
                  <PillCell
                    pills={listValues(row.original, tag.name).map((value) => ({
                      id: value,
                      label: value,
                    }))}
                    placeholder={$t("grid.addPill")}
                    onAdd={(text) => addToList(row.original, tag.name, text)}
                    onRemove={(id) => removeFromList(row.original, tag.name, id)}
                  />
                {:else if tag.kind === "references" ||
                  tag.kind === "reference"}
                  <PillCell
                    pills={refValues(row.original, tag.name).map((id) => ({
                      id,
                      label: ui.nameById[id] ?? "?",
                    }))}
                    placeholder={$t("grid.addRelation")}
                    options={relationOptions}
                    onAdd={(label) => addRelation(row.original, tag.name, label)}
                    onRemove={(id) => removeRelation(row.original, tag.name, id)}
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
        <tr class="ghost">
          <td class="select-col"></td>
          <td class="wordname-col">
            <input
              placeholder={$t("grid.ghostPlaceholder")}
              bind:value={ghostName}
              onkeydown={(e) => e.key === "Enter" && createGhost()}
              onblur={createGhost}
            />
          </td>
          <td></td>
          {#each tagColumns as tag (tag.name)}
            <td></td>
          {/each}
          <td></td>
        </tr>
      </tbody>
    </table>
  </div>
</div>

{#if addWordOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="modal-overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) addWordOpen = false;
    }}
  >
    <div class="modal add-word-modal" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-head">
        <span class="pane-title">{$t("grid.addWord")}</span>
        <button onclick={() => (addWordOpen = false)}><X size={16} /></button>
      </div>
      <div class="modal-body">
        <div class="row">
          <input
            placeholder={$t("grid.newWord")}
            bind:value={addWordName}
            onkeydown={(e) => e.key === "Enter" && submitAddWord()}
          />
          <button class="primary" onclick={submitAddWord}>
            {$t("grid.add")}
          </button>
        </div>
        {#if addWordError}<p class="error">{addWordError}</p>{/if}
      </div>
    </div>
  </div>
{/if}
