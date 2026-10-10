<!-- Trash bin modal (restore/delete). -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { FileText, Folder, Table2, X } from "@lucide/svelte";
  import * as api from "../lib/api";
  import {
    ui,
    confirmDialog,
    restoreFromTrash,
  } from "../lib/state.svelte";

  let items = $state<api.TrashRecord[]>([]);
  let error = $state("");

  async function reload() {
    try {
      items = await api.trashList();
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  // Refresh each time the view opens.
  $effect(() => {
    if (ui.trashOpen) void reload();
  });

  function close() {
    ui.trashOpen = false;
  }

  async function restore(item: api.TrashRecord) {
    await restoreFromTrash(item.id);
    await reload();
  }

  async function purge(item: api.TrashRecord) {
    const ok = await confirmDialog({
      title: $t("trash.purgeTitle"),
      message: $t("trash.purgeMessage", { values: { name: item.name } }),
      confirmLabel: $t("trash.deleteForever"),
      danger: true,
      kind: "trash-purge",
    });
    if (!ok) return;
    try {
      await api.trashPurge(item.id);
    } catch (e) {
      error = String(e);
    }
    await reload();
  }

  async function empty() {
    const ok = await confirmDialog({
      title: $t("trash.emptyTitle"),
      message: $t("trash.emptyMessage", { values: { count: items.length } }),
      confirmLabel: $t("trash.empty"),
      danger: true,
      kind: "trash-empty",
    });
    if (!ok) return;
    try {
      await api.trashEmpty();
    } catch (e) {
      error = String(e);
    }
    await reload();
  }

  function onKey(event: KeyboardEvent) {
    if (ui.trashOpen && !ui.confirm && event.key === "Escape") close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ui.trashOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal-overlay"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <div class="modal trash-modal" role="dialog" aria-modal="true" aria-label={$t("trash.title")}>
      <div class="modal-head">
        <span class="pane-title">{$t("trash.title")}</span>
        <button onclick={close} title={$t("grid.cancel")}><X size={16} /></button>
      </div>

      <div class="modal-body trash-list">
        {#each items as item (item.id)}
          <div class="trash-row">
            <span class="trash-icon">
              {#if item.kind === "table"}
                <Table2 size={15} />
              {:else if item.kind === "folder"}
                <Folder size={15} />
              {:else}
                <FileText size={15} />
              {/if}
            </span>
            <span class="trash-info">
              <span class="trash-name">{item.name}</span>
              <span class="muted trash-meta">
                {item.original}
                {#if item.count > 1}· {$t("trash.items", { values: { count: item.count } })}{/if}
                · {new Date(item.deleted_at * 1000).toLocaleString()}
              </span>
            </span>
            <button onclick={() => restore(item)}>{$t("trash.restore")}</button>
            <button class="danger" onclick={() => purge(item)}>
              {$t("trash.deleteForever")}
            </button>
          </div>
        {:else}
          <p class="muted trash-empty">{$t("trash.nothing")}</p>
        {/each}
        {#if error}<p class="error">{error}</p>{/if}
      </div>

      <div class="modal-foot">
        <span class="muted grow">{$t("trash.retention")}</span>
        <button class="danger" disabled={items.length === 0} onclick={empty}>
          {$t("trash.empty")}
        </button>
      </div>
    </div>
  </div>
{/if}
