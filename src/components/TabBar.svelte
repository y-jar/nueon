<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    FileText,
    Table2,
    Languages,
    X,
    PanelRight,
    PanelLeft,
    Plus,
  } from "@lucide/svelte";
  import {
    ui,
    activateTab,
    closeTab,
    createNote,
    moveTab,
    beginTabDrag,
    endTabDrag,
    finishTabDrag,
    openTabContextMenu,
    toggleInspector,
    toggleSidebar,
    setInspectorDock,
    type Tab,
    type TabGroup,
  } from "../lib/state.svelte";
  import { uniqueNotePath } from "../lib/explorer";

  import { isMainWindow } from "../lib/window";

  let { group }: { group: TabGroup } = $props();

  let marker = $state<{ id: string; after: boolean } | null>(null);
  let strip = $state<HTMLDivElement | null>(null);

  // Keep the active tab within the visible strip when it changes: opening a
  // note appends its tab at the end, and activating an off-screen tab should
  // reveal it. Scroll only the strip, never its ancestors.
  $effect(() => {
    const id = group.activeTabId;
    void group.tabs.length;
    if (!strip || !id) return;
    requestAnimationFrame(() => {
      const el = strip?.querySelector<HTMLElement>(".tab.active");
      if (!el || !strip) return;
      const tabRect = el.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      if (tabRect.left < stripRect.left) {
        strip.scrollLeft += tabRect.left - stripRect.left;
      } else if (tabRect.right > stripRect.right) {
        strip.scrollLeft += tabRect.right - stripRect.right;
      }
    });
  });

  function onDragStart(event: DragEvent, tab: Tab) {
    event.dataTransfer?.setData("text/plain", tab.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    beginTabDrag(tab.id, group.id);
  }

  function onDragEnd(event: DragEvent) {
    marker = null;
    void finishTabDrag(event.dataTransfer?.dropEffect ?? "none");
  }

  function onTabOver(event: DragEvent, tab: Tab) {
    if (!ui.dragTab) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    marker = { id: tab.id, after: event.clientX > rect.left + rect.width / 2 };
  }

  function onTabDrop(event: DragEvent, tab: Tab) {
    const drag = ui.dragTab;
    const after = marker?.after ?? false;
    event.preventDefault();
    event.stopPropagation();
    marker = null;
    endTabDrag();
    if (!drag) return;
    const index = group.tabs.findIndex((candidate) => candidate.id === tab.id);
    const before = after ? (group.tabs[index + 1]?.id ?? null) : tab.id;
    void moveTab(drag.tabId, drag.fromGroupId, group.id, before);
  }

  function onStripDrop(event: DragEvent) {
    const drag = ui.dragTab;
    if (!drag) return;
    event.preventDefault();
    marker = null;
    endTabDrag();
    void moveTab(drag.tabId, drag.fromGroupId, group.id, null);
  }

  function onAuxClick(event: MouseEvent, id: string) {
    if (event.button !== 1) return;
    // Leave the close button's own handling alone (its left-click closes).
    if ((event.target as HTMLElement).closest(".tab-close")) return;
    event.preventDefault();
    closeTab(group.id, id);
  }

  // Roving focus within the tablist: arrows move (and activate) the tab,
  // Home/End jump to the first/last. Modifier combos are left alone.
  function onStripKeydown(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const tabs = group.tabs;
    if (!tabs.length) return;
    const index = tabs.findIndex((tab) => tab.id === group.activeTabId);
    let next = index;
    if (event.key === "ArrowRight") next = Math.min(index + 1, tabs.length - 1);
    else if (event.key === "ArrowLeft") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    if (next !== index && next >= 0) void activateTab(group.id, tabs[next].id);
    requestAnimationFrame(() => {
      strip?.querySelector<HTMLElement>(".tab.active")?.focus();
    });
  }
</script>

<div class="tabbar">
  {#if isMainWindow}
    <button
      class="tab-action"
      title={$t("activity.toggleSidebar")}
      onclick={toggleSidebar}
    >
      <PanelLeft size={16} />
    </button>
  {/if}

  <div
    class="tab-strip"
    role="tablist"
    tabindex="-1"
    bind:this={strip}
    onkeydown={onStripKeydown}
    ondragover={(e) => {
      if (!ui.dragTab) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    }}
    ondragleave={(e) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))
        marker = null;
    }}
    ondrop={onStripDrop}
  >
    {#each group.tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={tab.id === group.activeTabId}
        class:dragging={ui.dragTab?.tabId === tab.id}
        class:drop-before={marker?.id === tab.id && !marker.after}
        class:drop-after={marker?.id === tab.id && marker.after}
        role="tab"
        aria-selected={tab.id === group.activeTabId}
        tabindex={tab.id === group.activeTabId ? 0 : -1}
        draggable="true"
        title={tab.ref ?? tab.title}
        onauxclick={(e) => onAuxClick(e, tab.id)}
        ondragstart={(e) => onDragStart(e, tab)}
        ondragend={onDragEnd}
        oncontextmenu={(e) => {
          e.preventDefault();
          openTabContextMenu(e.clientX, e.clientY, group.id, tab.id);
        }}
        ondragover={(e) => onTabOver(e, tab)}
        ondrop={(e) => onTabDrop(e, tab)}
      >
        <button
          class="tab-label"
          tabindex="-1"
          onclick={() => activateTab(group.id, tab.id)}
        >
          {#if tab.kind === "note"}
            <FileText size={13} />
          {:else if tab.kind === "table"}
            <Table2 size={13} />
          {:else}
            <Languages size={13} />
          {/if}
          <span class="tab-title">{tab.title}</span>
          {#if tab.kind === "note" &&
            group.doc.selected === tab.ref &&
            group.doc.dirty}
            <span class="tab-dot">•</span>
          {/if}
        </button>
        <button
          class="tab-close"
          tabindex={tab.id === group.activeTabId ? 0 : -1}
          title={$t("tabs.close")}
          aria-label={$t("tabs.close")}
          onclick={(e) => {
            e.stopPropagation();
            closeTab(group.id, tab.id);
          }}
        >
          <X size={12} />
        </button>
      </div>
    {/each}
  </div>

  <button
    class="tab-action tab-new"
    title={$t("tabs.newNote")}
    aria-label={$t("tabs.newNote")}
    onclick={() => void createNote(uniqueNotePath(ui.tree), group.id)}
  >
    <Plus size={16} />
  </button>

  {#if isMainWindow}
  <button
    class="tab-action"
    class:active={ui.inspectorOpen}
    title={$t("inspector.toggle")}
    onclick={toggleInspector}
    oncontextmenu={(e) => {
      e.preventDefault();
      setInspectorDock(ui.inspectorDock === "left" ? "right" : "left");
    }}
  >
    <PanelRight size={16} />
  </button>
  {/if}
</div>
