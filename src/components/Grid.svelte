<!-- The virtualized dictionary grid. -->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { save } from "@tauri-apps/plugin-dialog";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { autofocus } from "../lib/actions";
  import { t } from "svelte-i18n";
  import {
    createTable,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type ColumnDef,
    type ColumnSizingState,
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
    Upload,
    Eye,
    Download,
    Pencil,
    TriangleAlert,
  } from "@lucide/svelte";
  import * as api from "../lib/api";
  import { COLUMN_TYPES, displayValue, parseList, textValue, typeLabel } from "../lib/dictionary";
  import { misspelledWords } from "../lib/spellcheck";
  import {
    ui,
    openImport,
    openColumnMenu,
    selectTable,
    confirmDialog,
    type DocState,
  } from "../lib/state.svelte";
  import { createWordWithValues } from "../lib/words";
  import { normalizeView } from "../lib/gridView";
  import PillCell from "./PillCell.svelte";
  import GridCell from "./GridCell.svelte";
  import AddWordModal from "./AddWordModal.svelte";
  import DeleteWordModal from "./DeleteWordModal.svelte";
  import Popover from "./Popover.svelte";

  let {
    doc,
    onRefresh,
  }: { doc: DocState; onRefresh: () => void | Promise<void> } = $props();

  let sorting = $state<SortingState>([{ id: "wordname", desc: false }]);
  let filter = $state("");
  let columnVisibility = $state<VisibilityState>({});
  let columnOrder = $state<string[]>([]);
  let columnSizing = $state<ColumnSizingState>({});
  let dragColumn = $state<string | null>(null);
  let dropTarget = $state<{ id: string; after: boolean } | null>(null);
  let ghostName = $state("");
  let ghostValues = $state<Record<string, api.FieldValue>>({});
  let ghostParents = $state<string[]>([]);
  let ghostBusy = false;
  let error = $state("");
  let loadedTable = $state<string | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The view state waiting to be persisted, tagged with its table. */
  let pendingView: { name: string; snapshot: api.GridViewState } | null = null;

  let searchOpen = $state(false);
  let addWordOpen = $state(false);
  /** The word whose delete needs a dependents-aware prompt, if any. */
  let deleteTarget = $state<{
    table: string;
    id: string;
    wordname: string;
    children: api.RelatedWord[];
  } | null>(null);

  // Row virtualization: only the visible window of rows is in the DOM.
  let gridScroll = $state<HTMLDivElement | null>(null);
  let tbodyRef = $state<HTMLTableSectionElement | null>(null);
  /** Height of the sticky header that sits above the body. */
  let headerHeight = $state(0);

  let selectedIds = $state<string[]>([]);
  // Bulk-edit form (applies one value to every selected row).
  let bulkTag = $state("definition");
  let bulkText = $state("");
  let bulkList = $state("");
  let bulkBool = $state("true");
  let bulkRef = $state("");
  let newTagName = $state("");
  let newTagKind = $state("text");
  let knownTags = $state<string[]>([]);
  let tagError = $state("");
  let spellingIssue = $state<{ word: string; words: string[] } | null>(null);
  let pendingRemove = $state<{ tag: string; affected: number } | null>(null);
  let warnDismissed = $state(false);
  let dontWarnAgain = $state(false);

  /** Phonotactic warnings per word name (non-blocking). */
  let wordIssues = $state<Record<string, api.PhonologyViolation[]>>({});
  let issueRequest = 0;

  const FORMATS: api.TagFormat[] = ["default", "multiline", "date", "measurement"];

  /** Re-check every word name against the phonology, batched; never blocks. */
  async function refreshWordIssues(entries: api.WordEntry[]) {
    const words = entries.map((entry) => entry.wordname);
    const request = ++issueRequest;
    try {
      const results = await api.phonologyCheckWords(words);
      if (request !== issueRequest) return;
      const next: Record<string, api.PhonologyViolation[]> = {};
      words.forEach((word, index) => {
        const list = results[index];
        if (list && list.length) next[word] = list;
      });
      wordIssues = next;
    } catch {
      // A failed check must never get in the way of editing.
    }
  }

  $effect(() => {
    const entries = doc.table?.entries;
    if (!entries || entries.length === 0) {
      wordIssues = {};
      return;
    }
    void refreshWordIssues(entries);
  });

  function issueText(violations: api.PhonologyViolation[]): string {
    const reasons = violations
      .map((violation) =>
        violation.kind === "unknown_phoneme"
          ? $t("phonology.unknownPhoneme", {
              values: { symbol: violation.symbol, at: violation.at + 1 },
            })
          : $t("phonology.badSyllable"),
      )
      .join("; ");
    return $t("phonology.warning", { values: { reasons } });
  }

  const tagColumns = $derived(
    (doc.table?.tags ?? []).filter(
      (tag) =>
        tag.name !== "wordname" &&
        tag.name !== "parent" &&
        tag.name !== "definition",
    ),
  );

  /** Existing values per suggest-enabled column, for cell autocomplete. */
  const suggestionsByTag = $derived.by(() => {
    const map: Record<string, string[]> = {};
    for (const tag of doc.table?.tags ?? []) {
      if (!tag.suggest) continue;
      const values = new Set<string>();
      for (const entry of doc.table?.entries ?? []) {
        const value = entry.values[tag.name];
        if (value?.type === "tag_list") {
          for (const item of value.value) values.add(item);
        } else if (value?.type === "text" && value.value) {
          values.add(value.value);
        }
      }
      map[tag.name] = [...values];
    }
    return map;
  });

  /** Columns a bulk edit can target: the dedicated ones plus user tags. */
  const bulkColumns = $derived([
    { name: "definition", kind: "tag_list" as const },
    { name: "parent", kind: "references" as const },
    ...tagColumns.map((tag) => ({ name: tag.name, kind: tag.kind })),
  ]);
  const bulkKind = $derived(
    bulkColumns.find((column) => column.name === bulkTag)?.kind ?? "text",
  );

  const DEFAULT_COLUMN_WIDTH = 180;
  const MIN_COLUMN_WIDTH = 60;
  const SELECT_COLUMN_WIDTH = 28;
  const ACTION_COLUMN_WIDTH = 44;

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
    {
      id: "definition",
      accessorFn: (row: api.WordEntry) => displayValue(row.values["definition"]),
      header: "definition",
      filterFn: "includesString" as const,
    },
    ...tagColumns.map((tag) => ({
      id: tag.name,
      accessorFn: (row: api.WordEntry) => displayValue(row.values[tag.name]),
      header: tag.name,
      filterFn: "includesString" as const,
    })),
  ]);

  const table = $derived.by(() => {
    const instance = createTable<api.WordEntry>({
      data: doc.table?.entries ?? [],
      columns,
      state: {},
      enableColumnResizing: true,
      columnResizeMode: "onChange",
      defaultColumn: { size: DEFAULT_COLUMN_WIDTH, minSize: MIN_COLUMN_WIDTH },
      onColumnSizingChange: (updater) => {
        columnSizing =
          typeof updater === "function" ? updater(columnSizing) : updater;
      },
      onStateChange: () => {},
      renderFallbackValue: null,
      onSortingChange: (updater) => {
        sorting = typeof updater === "function" ? updater(sorting) : updater;
      },
      onGlobalFilterChange: (updater) => {
        filter = typeof updater === "function" ? updater(filter) : updater;
      },
      onColumnOrderChange: (updater) => {
        columnOrder =
          typeof updater === "function" ? updater(columnOrder) : updater;
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
    });
    // The raw table-core API does not merge defaults, so supply the full
    // state (columnPinning, expanded, ...) or `getState()` reads undefined.
    instance.setOptions((prev) => ({
      ...prev,
      state: {
        ...instance.initialState,
        sorting,
        globalFilter: filter,
        columnVisibility,
        columnSizing,
        // `wordname` is pinned first and never reordered.
        columnOrder: columnOrder.length
          ? ["wordname", ...columnOrder.filter((id) => id !== "wordname")]
          : [],
      },
    }));
    return instance;
  });

  const rows = $derived(table.getRowModel().rows);
  const visibleColumns = $derived(table.getVisibleLeafColumns());
  const tableWidth = $derived(
    SELECT_COLUMN_WIDTH +
      ACTION_COLUMN_WIDTH +
      visibleColumns.reduce((sum, column) => sum + column.getSize(), 0),
  );

  // Window the rows: a dictionary can hold thousands, and rendering every
  // row as a live DOM node made scrolling crawl. `scrollMargin` is the sticky
  // header's height, so the window lines up with the body.
  //
  // `rowEstimate` tracks the real (often wrapped-pill) row height. A fixed
  // estimate far below it made the total size climb mid-scroll as rows were
  // measured — the scrollbar and positions jumped. Easing the estimate toward
  // measured heights keeps the total stable without truncating cell content.
  let rowEstimate = $state(44);
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLElement>({
    // The real count is pushed in by the effect below, so this avoids
    // capturing a stale initial `rows`.
    count: 0,
    getScrollElement: () => gridScroll,
    estimateSize: () => rowEstimate,
    overscan: 12,
    getItemKey: (index) => rows[index]?.id ?? index,
  });
  // Read the sticky header's height once the elements exist.
  $effect(() => {
    if (!gridScroll || !tbodyRef) return;
    headerHeight =
      tbodyRef.getBoundingClientRect().top -
      gridScroll.getBoundingClientRect().top +
      gridScroll.scrollTop;
  });

  // Keep the virtualizer's count and header margin current. `$effect.pre` runs
  // before the DOM updates, so a filter that shrinks the row set is reflected
  // in the same pass rather than one render late.
  $effect.pre(() => {
    const count = rows.length;
    get(virtualizer).setOptions({ count, scrollMargin: headerHeight });
  });

  const virtualRows = $derived($virtualizer.getVirtualItems());
  const virtualTotalSize = $derived($virtualizer.getTotalSize());
  const paddingTop = $derived(
    virtualRows.length ? virtualRows[0].start - headerHeight : 0,
  );
  const paddingBottom = $derived(
    virtualRows.length
      ? virtualTotalSize -
          virtualRows[virtualRows.length - 1].end +
          headerHeight
      : 0,
  );

  function measureRow(node: HTMLElement) {
    $virtualizer.measureElement(node);
    const height = node.getBoundingClientRect().height;
    // Ease the estimate toward the real height so wrapped rows stop shifting
    // the total size; small deltas are ignored to avoid churn.
    if (height > 0 && Math.abs(height - rowEstimate) > 4) {
      rowEstimate = Math.round(rowEstimate + (height - rowEstimate) * 0.3);
    }
  }

  function tagOf(name: string): api.TagDef | undefined {
    return tagColumns.find((tag) => tag.name === name);
  }

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

  /**
   * Write the view state waiting in the debounce window right now, under the
   * table it belongs to, and cancel the timer. Returns once the write is
   * sent, so a caller can await it before switching tables.
   */
  async function flushViewState(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const pending = pendingView;
    pendingView = null;
    if (pending) {
      try {
        await api.gridViewSet(pending.name, pending.snapshot);
      } catch {
        // Presentation state only: a failed write is not worth surfacing.
      }
    }
  }

  // Load persisted view state when the active table changes. Any edit still
  // inside the debounce window is flushed **first**, under the table being
  // left, so a resize or reorder made moments before the switch is not lost.
  $effect(() => {
    const name = doc.currentTable;
    if (!name || name === loadedTable) return;
    void (async () => {
      await flushViewState();
      let view: api.GridViewState | null = null;
      try {
        view = await api.gridViewGet(name);
      } catch {
        view = null;
      }
      // A newer switch may have happened while we were talking to the backend.
      if (doc.currentTable !== name) return;

      // The backend omits empty fields, so every one is defaulted here. A
      // view with nothing hidden or reordered genuinely arrives as `{}`, and
      // must not throw on the way to a usable grid.
      const savedSorting = view?.sorting ?? [];
      sorting = savedSorting.length
        ? savedSorting.map((spec) => ({ id: spec.id, desc: spec.desc }))
        : [{ id: "wordname", desc: false }];
      // A search is a transient action, not saved state: never restore one
      // (doing so used to leave a filter active with its box hidden).
      filter = "";
      columnVisibility = Object.fromEntries(
        (view?.hidden_columns ?? []).map((id) => [id, false]),
      );
      // `wordname` is always pinned first and never loaded into the order.
      columnOrder = (view?.column_order ?? []).filter((id) => id !== "wordname");
      columnSizing = view?.column_widths ?? {};
      selectedIds = [];
      loadedTable = name;
    })();
  });

  // Persist view state (debounced) whenever the grid presentation changes.
  //
  // Every reactive input is read here, before the guard, so the effect
  // re-runs whenever any of them changes — including a resize that happens
  // while `loadedTable` is still settling. Reading them only past the guard
  // would register no dependencies and silently stop saving.
  $effect(() => {
    const name = doc.currentTable;
    // Ids that still exist, so a removed or renamed tag is never written
    // back. New columns are not in the stored order, so they land last;
    // `wordname` is always first and never stored in another position.
    // Crucially, nothing is pruned until the table's columns have actually
    // loaded — a save that fires early must not discard the real ids and
    // widths it has not yet had a chance to verify.
    const { order, widths } = normalizeView({
      columnOrder,
      columnSizing,
      knownIds: table
        .getAllLeafColumns()
        .map((column) => column.id)
        .filter((id) => id !== "wordname"),
      columnsLoaded: doc.table !== null,
    });
    const snapshot: api.GridViewState = {
      sorting: sorting.map((spec) => ({ id: spec.id, desc: spec.desc })),
      search: "",
      column_filters: {},
      hidden_columns: Object.entries(columnVisibility)
        .filter(([, visible]) => !visible)
        .map(([id]) => id),
      column_order: order,
      column_widths: widths,
    };

    if (!name || name !== loadedTable) return;
    pendingView = { name, snapshot };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void flushViewState();
    }, 400);
  });

  // Best-effort flush when the window goes away. The async save is sent, but
  // if the webview is torn down immediately the IPC may not complete — that
  // is the one case not fully guaranteed. Switching tables and unmounting
  // (closing the tab) are guaranteed, because those are awaited.
  $effect(() => {
    const onHide = () => {
      void flushViewState();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  });

  // Closing the editor tab (or leaving the dictionary view) unmounts the
  // grid; flush first so a just-made change is not dropped.
  onDestroy(() => {
    void flushViewState();
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
    const value = entry.values?.["parent"];
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

  const hasHiddenColumns = $derived(
    Object.values(columnVisibility).some((visible) => visible === false),
  );

  function openColumnContext(
    event: MouseEvent,
    column: { id: string; getCanHide: () => boolean },
  ) {
    const id = column.id;
    const tag = tagOf(id);
    openColumnMenu(event.clientX, event.clientY, {
      id,
      canHide: column.getCanHide(),
      isTag: !!tag,
      kind: tag ? tag.kind : null,
      onHide: () => toggleColumn(id, false),
      onSortAsc: () => (sorting = [{ id, desc: false }]),
      onSortDesc: () => (sorting = [{ id, desc: true }]),
      onClearSort: () => (sorting = [{ id: "wordname", desc: false }]),
      onChangeKind: tag ? (kind) => changeKind(id, kind) : undefined,
      onDelete: tag ? () => removeTag(id) : undefined,
    });
  }

  function toggleColumn(id: string, visible: boolean) {
    columnVisibility = { ...columnVisibility, [id]: visible };
  }

  const sortId = $derived(sorting[0]?.id ?? "wordname");
  const sortDesc = $derived(Boolean(sorting[0]?.desc));

  /** Ascending → descending → the default sort (wordname, ascending). */
  function cycleSort(id: string) {
    const current = sorting[0];
    if (!current || current.id !== id) {
      sorting = [{ id, desc: false }];
    } else if (!current.desc) {
      sorting = [{ id, desc: true }];
    } else {
      sorting = [{ id: "wordname", desc: false }];
    }
  }

  function sortIndicator(id: string): string {
    const current = sorting[0];
    if (!current || current.id !== id) return "⇅";
    return current.desc ? "▼" : "▲";
  }

  /** Drag a header's right edge to resize; the width is kept in TanStack state. */
  function startResize(event: MouseEvent, id: string, startWidth: number) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const onMove = (move: MouseEvent) => {
      const width = Math.max(
        MIN_COLUMN_WIDTH,
        Math.round(startWidth + move.clientX - startX),
      );
      columnSizing = { ...columnSizing, [id]: width };
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-resizing");
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function resetWidth(id: string) {
    const next = { ...columnSizing };
    delete next[id];
    columnSizing = next;
  }

  function onColumnDragStart(event: DragEvent, id: string) {
    if ((event.target as HTMLElement | null)?.closest(".col-resizer")) {
      event.preventDefault();
      return;
    }
    dragColumn = id;
    event.dataTransfer?.setData("text/plain", id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function onColumnDragOver(event: DragEvent, id: string) {
    if (!dragColumn || dragColumn === id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    // Dropping on the pinned wordname column inserts right after it.
    const after = id === "wordname" || event.clientX > rect.left + rect.width / 2;
    dropTarget = { id, after };
  }

  function onColumnDrop(event: DragEvent) {
    event.preventDefault();
    const target = dropTarget;
    const moving = dragColumn;
    dragColumn = null;
    dropTarget = null;
    if (!target || !moving || moving === target.id) return;
    const ids = table
      .getAllLeafColumns()
      .map((column) => column.id)
      .filter((id) => id !== moving);
    const at = ids.indexOf(target.id) + (target.after ? 1 : 0);
    ids.splice(at, 0, moving);
    columnOrder = ids.filter((id) => id !== "wordname");
  }

  function onColumnDragEnd() {
    dragColumn = null;
    dropTarget = null;
  }

  function setSortColumn(id: string) {
    sorting = [{ id, desc: sortDesc }];
  }

  function toggleSortDir() {
    sorting = [{ id: sortId, desc: !sortDesc }];
  }

  function setGhost(tag: string, value: api.FieldValue | null) {
    const next = { ...ghostValues };
    if (value) next[tag] = value;
    else delete next[tag];
    ghostValues = next;
  }

  function ghostList(tag: string): string[] {
    const value = ghostValues[tag];
    return value && value.type === "tag_list" ? value.value : [];
  }

  function ghostSetList(tag: string, items: string[]) {
    setGhost(tag, items.length ? { type: "tag_list", value: items } : null);
  }

  function optionId(label: string, excludeId?: string): string | null {
    const option = relationOptions.find((item) => item.label === label);
    return option && option.id !== excludeId ? option.id : null;
  }

  async function createGhost() {
    const name = ghostName.trim();
    if (!name || !doc.currentTable || ghostBusy) return;
    ghostBusy = true;
    const values = { ...ghostValues };
    const parents = [...ghostParents];
    try {
      const result = await createWordWithValues(
        doc.currentTable,
        name,
        values,
        parents,
      );
      ghostName = "";
      ghostValues = {};
      ghostParents = [];
      error = result.rejectedParents ? $t("grid.parentRejected") : "";
      await onRefresh();
    } catch (e) {
      error = String(e);
    } finally {
      ghostBusy = false;
    }
  }

  function onGhostFocusOut(event: FocusEvent) {
    const row = event.currentTarget as HTMLElement;
    // Create the word once focus leaves the whole ghost row, so Tab can
    // move between its cells without committing a half-filled draft.
    if (!row.contains(event.relatedTarget as Node | null)) void createGhost();
  }

  /** Enter commits (via blur); Escape reverts the edit. */
  function onCellKey(event: KeyboardEvent, original: string) {
    const field = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
    if (event.key === "Escape") {
      field.value = original;
      field.blur();
    } else if (
      event.key === "Enter" &&
      (field instanceof HTMLInputElement || event.ctrlKey)
    ) {
      event.preventDefault();
      field.blur();
    }
  }

  async function addParent(entry: api.WordEntry, label: string) {
    if (!doc.currentTable) return;
    const id = optionId(label, entry.id);
    if (!id || refValues(entry, "parent").includes(id)) return;
    const ok = await api.setParent(doc.currentTable, entry.id, id);
    error = ok ? "" : $t("grid.parentRejected");
  }

  async function removeParentOf(entry: api.WordEntry, id: string) {
    if (!doc.currentTable) return;
    await api.removeParent(doc.currentTable, entry.id, id);
  }

  // Every commit* / set*Values function below patches one field against
  // whatever is *currently* stored, rather than sending a whole entry built
  // from a snapshot the Grid might be holding stale. That is what lets the
  // Grid and the Inspector (or two Grid cells) edit different fields of the
  // same word without one save silently erasing the other's.

  async function commitWordname(entry: api.WordEntry, value: string) {
    const next = value.trim();
    if (!next || next === entry.wordname || !doc.currentTable) return;
    await api.renameWord(doc.currentTable, entry.id, next);
  }

  async function commitText(entry: api.WordEntry, tag: string, value: string) {
    if (!doc.currentTable) return;
    if (textValue(entry.values[tag]) === value) return;
    await api.setWordValue(
      doc.currentTable,
      entry.id,
      tag,
      value === "" ? null : { type: "text", value },
    );
  }

  async function commitBool(entry: api.WordEntry, tag: string, value: boolean) {
    if (!doc.currentTable) return;
    await api.setWordValue(doc.currentTable, entry.id, tag, {
      type: "boolean",
      value,
    });
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
    if (tag === "definition") {
      await api.setWordDefinition(doc.currentTable, entry.id, values);
    } else {
      await api.setWordValue(
        doc.currentTable,
        entry.id,
        tag,
        values.length ? { type: "tag_list", value: values } : null,
      );
    }
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
    await api.setWordValue(
      doc.currentTable,
      entry.id,
      tag,
      values.length ? { type: "references", value: values } : null,
    );
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
    const table = doc.currentTable;
    if (!table) return;
    try {
      const tree = await api.derivationTree(entry.id);
      if (tree.children.length) {
        // Deleting a word others derive from needs a dependents-aware prompt.
        deleteTarget = {
          table,
          id: entry.id,
          wordname: entry.wordname,
          children: tree.children,
        };
        return;
      }
      await api.deleteWord(table, entry.id);
    } catch (e) {
      error = String(e);
    }
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
    const table = doc.currentTable;
    if (!table || selectedIds.length === 0) return;
    const count = selectedIds.length;
    const confirmed = await confirmDialog({
      title: $t("deleteWord.bulkTitle"),
      message: $t("deleteWord.bulkMessage", { values: { count } }),
      confirmLabel: $t("deleteWord.confirm"),
      danger: true,
      requireText: "Im sure",
    });
    if (!confirmed) return;
    const ids = selectedIds;
    for (const id of ids) {
      await api.deleteWord(table, id);
    }
    selectedIds = [];
  }

  /** The value the bulk form would apply (null = clear the field). */
  function buildBulkValue(): api.FieldValue | null {
    switch (bulkKind) {
      case "boolean":
        return { type: "boolean", value: bulkBool === "true" };
      case "tag_list": {
        const values = parseList(bulkList);
        return values.length ? { type: "tag_list", value: values } : null;
      }
      case "references":
        return bulkRef ? { type: "references", value: [bulkRef] } : null;
      case "reference":
        return bulkRef ? { type: "reference", value: bulkRef } : null;
      default:
        return bulkText === "" ? null : { type: "text", value: bulkText };
    }
  }

  async function applyBulk() {
    if (!doc.currentTable || selectedIds.length === 0) return;
    await api.setWordsValue(
      doc.currentTable,
      selectedIds,
      bulkTag,
      buildBulkValue(),
    );
    await onRefresh();
  }

  async function clearBulk() {
    if (!doc.currentTable || selectedIds.length === 0) return;
    await api.setWordsValue(doc.currentTable, selectedIds, bulkTag, null);
    await onRefresh();
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

  async function changeSuggest(name: string, suggest: boolean) {
    if (!doc.currentTable) return;
    await api.setTagSuggest(doc.currentTable, name, suggest);
    onRefresh();
  }

  /** Save the active table to a file (CSV/TSV, or a lossless JSON backup). */
  async function exportAs(format: api.TableFormat) {
    const name = doc.currentTable;
    if (!name) return;
    try {
      const destination = await save({
        defaultPath: `${name}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!destination) return;
      ui.status = $t("status.exporting", { values: { name } });
      ui.status = await api.exportTable(name, format, destination);
      ui.status = $t("status.exported", { values: { name, path: destination } });
    } catch (e) {
      ui.status = $t("status.exportFailed", { values: { error: String(e) } });
    }
  }

  /** Save the active table as an Anki-importable text file (`.txt`). */
  async function exportAnki() {
    const name = doc.currentTable;
    if (!name) return;
    try {
      const destination = await save({
        defaultPath: `${name}.txt`,
        filters: [{ name: "Anki text", extensions: ["txt"] }],
      });
      if (!destination) return;
      ui.status = $t("status.exporting", { values: { name } });
      ui.status = await api.exportAnki(name, { deck: name }, destination);
      ui.status = $t("status.exported", { values: { name, path: destination } });
    } catch (e) {
      ui.status = $t("status.exportFailed", { values: { error: String(e) } });
    }
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

    <Popover>
      {#snippet label()}<ArrowUpDown size={14} /> {$t("grid.sort")}{/snippet}
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
    </Popover>

    <button
      class="tool-btn"
      class:active={searchOpen}
      title={$t("grid.search")}
      onclick={() => {
        searchOpen = !searchOpen;
        // Closing the box cancels the filter rather than hiding it, so a
        // hidden filter can never silently keep narrowing the grid.
        if (!searchOpen) filter = "";
      }}
    >
      <Search size={14} />
    </button>

    <span class="grow"></span>

    <button title={$t("grid.undo")} onclick={doUndo}><Undo2 size={14} /></button>
    <button title={$t("grid.redo")} onclick={doRedo}><Redo2 size={14} /></button>

    <Popover align="right">
      {#snippet label()}<Columns3 size={14} /> {$t("grid.columns")}{/snippet}
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
    </Popover>

    <Popover align="right">
      {#snippet label()}<Upload size={14} /> {$t("grid.export")}{/snippet}
      <div class="picker-body">
        <button onclick={() => exportAs("csv")}>{$t("grid.exportCsv")}</button>
        <button onclick={() => exportAs("tsv")}>{$t("grid.exportTsv")}</button>
        <button onclick={() => exportAs("json")}>{$t("grid.exportJson")}</button>
        <button onclick={exportAnki}>{$t("grid.exportAnki")}</button>
      </div>
    </Popover>

    {#if hasHiddenColumns}
      <button
        title={$t("grid.unhideColumns")}
        aria-label={$t("grid.unhideColumns")}
        onclick={() => (columnVisibility = {})}
      >
        <Eye size={14} />
      </button>
    {/if}

    <Popover align="right">
      {#snippet label()}<Tags size={14} /> {$t("grid.tags")}{/snippet}
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
              {#if tag.kind === "text" || tag.kind === "tag_list"}
                <label class="suggest-toggle" title={$t("grid.suggestValues")}>
                  <input
                    type="checkbox"
                    checked={tag.suggest ?? false}
                    onchange={(e) =>
                      changeSuggest(tag.name, e.currentTarget.checked)}
                  />
                  {$t("grid.suggest")}
                </label>
              {/if}
              <button title={$t("grid.removeTag")} onclick={() => removeTag(tag.name)}>
                <X size={13} />
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </Popover>

    <button
      title={$t("import.title")}
      aria-label={$t("import.title")}
      onclick={() => openImport()}
    >
      <Download size={14} />
    </button>

    <button class="primary" onclick={() => (addWordOpen = true)}>
      {$t("grid.addWord")}
    </button>

    {#if selectedIds.length}
      <span class="muted"
        >{$t("grid.selected", { values: { count: selectedIds.length } })}</span
      >
      <Popover align="right">
        {#snippet label()}<Pencil size={14} /> {$t("grid.bulkEdit")}{/snippet}
        {#snippet children(close)}
          <div class="picker-body">
            <label class="field"
              >{$t("grid.column")}
              <select bind:value={bulkTag}>
                {#each bulkColumns as column (column.name)}
                  <option value={column.name}>{column.name}</option>
                {/each}
              </select>
            </label>

            {#if bulkKind === "boolean"}
              <select bind:value={bulkBool}>
                <option value="true">{$t("grid.checked")}</option>
                <option value="false">{$t("grid.unchecked")}</option>
              </select>
            {:else if bulkKind === "references" || bulkKind === "reference"}
              <select bind:value={bulkRef}>
                <option value="">—</option>
                {#each relationOptions as option (option.id)}
                  <option value={option.id}>{option.label}</option>
                {/each}
              </select>
            {:else if bulkKind === "tag_list"}
              <input
                placeholder={$t("grid.commaList")}
                bind:value={bulkList}
              />
            {:else}
              <input bind:value={bulkText} />
            {/if}

            <div class="row">
              <button
                class="primary"
                onclick={() => {
                  void applyBulk();
                  close();
                }}>{$t("grid.apply")}</button
              >
              <button
                onclick={() => {
                  void clearBulk();
                  close();
                }}>{$t("grid.clearValue")}</button
              >
            </div>
          </div>
        {/snippet}
      </Popover>
      <button onclick={deleteSelected}>{$t("grid.deleteSelected")}</button>
    {/if}
  </div>

  {#if searchOpen}
    <div class="grid-search">
      <Search size={14} />
      <input
        use:autofocus
        placeholder={$t("grid.search")}
        bind:value={filter}
        onkeydown={(e) => {
          if (e.key !== "Escape") return;
          filter = "";
          searchOpen = false;
        }}
      />
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

  <div class="grid-scroll" bind:this={gridScroll}>
    <table class="dict-grid" style:width="{tableWidth}px">
      <colgroup>
        <col style:width="{SELECT_COLUMN_WIDTH}px" />
        {#each visibleColumns as column (column.id)}
          <col style:width="{column.getSize()}px" />
        {/each}
        <col style:width="{ACTION_COLUMN_WIDTH}px" />
      </colgroup>
      <thead>
        <tr>
          <th class="select-col">
            <input
              type="checkbox"
              checked={rows.length > 0 && selectedIds.length === rows.length}
              onchange={(e) => toggleAll(e.currentTarget.checked)}
            />
          </th>
          {#each visibleColumns as column (column.id)}
            <th
              class:wordname-col={column.id === "wordname"}
              class:dragging={dragColumn === column.id}
              class:drop-before={dropTarget?.id === column.id &&
                !dropTarget.after}
              class:drop-after={dropTarget?.id === column.id &&
                dropTarget.after}
              draggable={column.id === "wordname" ? "false" : "true"}
              ondragstart={(e) => onColumnDragStart(e, column.id)}
              ondragover={(e) => onColumnDragOver(e, column.id)}
              ondrop={onColumnDrop}
              ondragend={onColumnDragEnd}
              oncontextmenu={(e) => {
                e.preventDefault();
                openColumnContext(e, column);
              }}
            >
              <button
                class="sort"
                title={$t("grid.sortHint")}
                onclick={() => cycleSort(column.id)}
              >
                {column.id}
                <span
                  class="sort-ind"
                  class:on={sorting[0]?.id === column.id}
                  >{sortIndicator(column.id)}</span
                >
              </button>
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <span
                class="col-resizer"
                role="separator"
                aria-orientation="vertical"
                title={$t("grid.resizeHint")}
                onmousedown={(e) => startResize(e, column.id, column.getSize())}
                ondblclick={() => resetWidth(column.id)}
              ></span>
            </th>
          {/each}
          <th></th>
        </tr>
      </thead>
      <tbody bind:this={tbodyRef}>
        {#if paddingTop > 0}
          <tr class="virtual-spacer" aria-hidden="true">
            <td
              colspan={visibleColumns.length + 2}
              style="height:{paddingTop}px;padding:0;border:0"
            ></td>
          </tr>
        {/if}
        {#each virtualRows as vrow (vrow.key)}
          {@const row = rows[vrow.index]}
          <tr
            data-index={vrow.index}
            use:measureRow
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
            {#each visibleColumns as column (column.id)}
              {#if column.id === "wordname"}
                <td class="wordname-col" onclick={(e) => e.stopPropagation()}>
                  <input
                    value={row.original.wordname}
                    onkeydown={(e) => onCellKey(e, row.original.wordname)}
                    onblur={(e) =>
                      commitWordname(row.original, e.currentTarget.value)}
                  />
                  {#if wordIssues[row.original.wordname]?.length}
                    <span
                      class="word-warning"
                      role="img"
                      title={issueText(wordIssues[row.original.wordname])}
                      aria-label={issueText(wordIssues[row.original.wordname])}
                    >
                      <TriangleAlert size={12} />
                    </span>
                  {/if}
                </td>
              {:else if column.id === "parent"}
                <td class="editable" onclick={(e) => e.stopPropagation()}>
                  <PillCell
                    pills={refValues(row.original, "parent").map((id) => ({
                      id,
                      label: ui.nameById[id] ?? "?",
                    }))}
                    placeholder={$t("grid.addParent")}
                    options={relationOptions}
                    onAdd={(label) => addParent(row.original, label)}
                    onRemove={(id) => removeParentOf(row.original, id)}
                  />
                </td>
              {:else if column.id === "definition"}
                <td class="editable" onclick={(e) => e.stopPropagation()}>
                  <PillCell
                    pills={listValues(row.original, "definition").map(
                      (value) => ({ id: value, label: value }),
                    )}
                    placeholder={$t("grid.addPill")}
                    onAdd={(text) =>
                      addToList(row.original, "definition", text)}
                    onRemove={(id) =>
                      removeFromList(row.original, "definition", id)}
                  />
                </td>
              {:else}
                {@const tag = tagOf(column.id)}
                <td class="editable" onclick={(e) => e.stopPropagation()}>
                  {#if tag}
                    <GridCell
                      {tag}
                      entry={row.original}
                      ghostValues={ghostValues}
                      suggestions={suggestionsByTag[tag.name] ?? []}
                      relationOptions={relationOptions}
                      nameById={ui.nameById}
                      {onCellKey}
                      {commitText}
                      {commitBool}
                      {addToList}
                      {removeFromList}
                      {addRelation}
                      {removeRelation}
                      {setGhost}
                      {createGhost}
                      {optionId}
                    />
                  {/if}
                </td>
              {/if}
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
        {#if paddingBottom > 0}
          <tr class="virtual-spacer" aria-hidden="true">
            <td
              colspan={visibleColumns.length + 2}
              style="height:{paddingBottom}px;padding:0;border:0"
            ></td>
          </tr>
        {/if}
        <tr class="ghost" onfocusout={onGhostFocusOut}>
          <td class="select-col"></td>
          {#each visibleColumns as column (column.id)}
            {#if column.id === "wordname"}
              <td class="wordname-col">
                <input
                  placeholder={$t("grid.ghostPlaceholder")}
                  bind:value={ghostName}
                  onkeydown={(e) => e.key === "Enter" && createGhost()}
                />
              </td>
            {:else if column.id === "parent"}
              <td class="editable">
                <PillCell
                  pills={ghostParents.map((id) => ({
                    id,
                    label: ui.nameById[id] ?? "?",
                  }))}
                  placeholder={$t("grid.addParent")}
                  options={relationOptions}
                  onAdd={(label) => {
                    const id = optionId(label);
                    if (id && !ghostParents.includes(id))
                      ghostParents = [...ghostParents, id];
                  }}
                  onRemove={(id) =>
                    (ghostParents = ghostParents.filter((p) => p !== id))}
                />
              </td>
            {:else if column.id === "definition"}
              <td class="editable">
                <PillCell
                  pills={ghostList("definition").map((value) => ({
                    id: value,
                    label: value,
                  }))}
                  placeholder={$t("grid.addPill")}
                  onAdd={(text) => {
                    const items = ghostList("definition");
                    if (!items.includes(text))
                      ghostSetList("definition", [...items, text]);
                  }}
                  onRemove={(id) =>
                    ghostSetList(
                      "definition",
                      ghostList("definition").filter((item) => item !== id),
                    )}
                />
              </td>
            {:else}
              {@const tag = tagOf(column.id)}
              <td class="editable">
                {#if tag}
                  <GridCell
                    {tag}
                    entry={null}
                    ghostValues={ghostValues}
                    suggestions={suggestionsByTag[tag.name] ?? []}
                    relationOptions={relationOptions}
                    nameById={ui.nameById}
                    {onCellKey}
                    {commitText}
                    {commitBool}
                    {addToList}
                    {removeFromList}
                    {addRelation}
                    {removeRelation}
                    {setGhost}
                    {createGhost}
                    {optionId}
                  />
                {/if}
              </td>
            {/if}
          {/each}
          <td></td>
        </tr>
      </tbody>
    </table>
  </div>
</div>

{#if addWordOpen && doc.currentTable}
  <AddWordModal
    table={doc.currentTable}
    tags={doc.table?.tags ?? []}
    options={relationOptions}
    nameById={ui.nameById}
    suggestions={suggestionsByTag}
    onClose={() => (addWordOpen = false)}
    onCreated={onRefresh}
  />
{/if}

{#if deleteTarget}
  <DeleteWordModal
    table={deleteTarget.table}
    id={deleteTarget.id}
    wordname={deleteTarget.wordname}
    children={deleteTarget.children}
    onClose={() => (deleteTarget = null)}
    onDeleted={onRefresh}
  />
{/if}
