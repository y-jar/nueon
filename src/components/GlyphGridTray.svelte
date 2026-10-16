<!-- Bottom tray of glyph thumbnails, with multi-select batch actions. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { Plus } from "@lucide/svelte";
  import type { GlyphMeta } from "../lib/api";
  import { toggleSelected } from "../lib/writingBatch";

  interface Props {
    glyphs: GlyphMeta[];
    currentId: string | null;
    onOpen: (glyph: GlyphMeta) => void;
    onAdd: () => void;
    onBatchDelete: (ids: string[]) => void;
    onBatchGroup: (ids: string[], group: string) => void;
    onBatchAdvance: (ids: string[], advance: number) => void;
    onBatchExport: (ids: string[]) => void;
  }

  let {
    glyphs,
    currentId,
    onOpen,
    onAdd,
    onBatchDelete,
    onBatchGroup,
    onBatchAdvance,
    onBatchExport,
  }: Props = $props();

  let selectMode = $state(false);
  let selected = $state<string[]>([]);
  let group = $state("");
  let advance = $state("");

  function click(glyph: GlyphMeta) {
    if (selectMode) selected = toggleSelected(selected, glyph.id);
    else onOpen(glyph);
  }

  function leave() {
    selectMode = false;
    selected = [];
  }

  function applyAdvance() {
    const value = Number(advance);
    if (advance.trim() === "" || !Number.isFinite(value) || selected.length === 0) return;
    onBatchAdvance(selected, value);
    advance = "";
  }
</script>

{#if selectMode}
  <div class="batch-bar">
    <span>{$t("writing.selected", { values: { count: selected.length } })}</span>
    <input placeholder={$t("writing.batchGroup")} bind:value={group} />
    <button disabled={selected.length === 0} onclick={() => onBatchGroup(selected, group)}>
      {$t("writing.batchGroup")}
    </button>
    <input type="number" placeholder={$t("writing.batchAdvance")} bind:value={advance} />
    <button disabled={selected.length === 0} onclick={applyAdvance}>
      {$t("writing.batchMetrics")}
    </button>
    <button disabled={selected.length === 0} onclick={() => onBatchExport(selected)}>
      {$t("writing.batchExport")}
    </button>
    <button
      class="danger"
      disabled={selected.length === 0}
      onclick={() => {
        onBatchDelete(selected);
        leave();
      }}
    >
      {$t("writing.batchDelete")}
    </button>
    <button onclick={leave}>{$t("writing.batchClear")}</button>
  </div>
{/if}

<div class="glyph-tray">
  <button
    class="tray-tile"
    class:batch-selected={selectMode}
    title={$t("writing.selectModeHint")}
    onclick={() => (selectMode ? leave() : (selectMode = true))}
  >
    {$t("writing.selectMode")}
  </button>
  {#each glyphs as glyph (glyph.id)}
    <button
      class="tray-tile"
      class:active={glyph.id === currentId}
      class:batch-selected={selected.includes(glyph.id)}
      title={glyph.name}
      onclick={() => click(glyph)}
    >
      {glyph.name}
    </button>
  {/each}
  <button class="tray-tile tray-add" title={$t("writing.addGlyph")} onclick={onAdd}>
    <Plus size={14} />
  </button>
</div>
