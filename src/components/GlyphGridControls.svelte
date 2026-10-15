<!-- Grid controls: cell size, sound and fill filters, text search, and the progress line. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { CELL_SIZES, MAX_CELL, MIN_CELL, type GridFilter } from "../lib/writingGrid";

  interface Props {
    filter: GridFilter;
    cellSize: number;
    progress: { drawn: number; total: number };
    shown: number;
    onFilter: (next: GridFilter) => void;
    onSize: (px: number) => void;
    spacing: boolean;
    onSpacing: (on: boolean) => void;
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
  }

  let {
    filter,
    cellSize,
    progress,
    shown,
    onFilter,
    onSize,
    spacing,
    onSpacing,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
  }: Props = $props();

  const SOUNDS = ["all", "consonant", "vowel", "other", "unmapped"] as const;
  const FILLS = ["all", "drawn", "empty"] as const;
</script>

<div class="grid-controls" data-testid="grid-controls">
  <span class="grid-progress" data-testid="grid-progress">
    {$t("writing.progress", { values: { drawn: progress.drawn, total: progress.total } })}
  </span>
  <progress class="grid-progress-bar" max={Math.max(1, progress.total)} value={progress.drawn}></progress>
  <span class="grow"></span>
  <button
    class="spacing-toggle"
    class:active={spacing}
    aria-pressed={spacing}
    data-testid="spacing-toggle"
    title={$t("writing.spacing.hint")}
    onclick={() => onSpacing(!spacing)}
  >
    {$t("writing.spacing.mode")}
  </button>
  {#if spacing}
    <button disabled={!canUndo} data-testid="spacing-undo" onclick={onUndo}>{$t("writing.spacing.undo")}</button>
    <button disabled={!canRedo} data-testid="spacing-redo" onclick={onRedo}>{$t("writing.spacing.redo")}</button>
  {/if}
  <input
    class="grid-search"
    type="search"
    placeholder={$t("writing.sidebarSearch")}
    value={filter.text}
    oninput={(e) => onFilter({ ...filter, text: e.currentTarget.value })}
  />
  <select
    aria-label={$t("writing.filterSound")}
    value={filter.sound}
    onchange={(e) => onFilter({ ...filter, sound: e.currentTarget.value as GridFilter["sound"] })}
  >
    {#each SOUNDS as s (s)}<option value={s}>{$t(`writing.sound.${s}`)}</option>{/each}
  </select>
  <select
    aria-label={$t("writing.filterFill")}
    value={filter.fill}
    onchange={(e) => onFilter({ ...filter, fill: e.currentTarget.value as GridFilter["fill"] })}
  >
    {#each FILLS as f (f)}<option value={f}>{$t(`writing.fill.${f}`)}</option>{/each}
  </select>
  <div class="size-group" role="group" aria-label={$t("writing.cellSize")}>
    {#each Object.entries(CELL_SIZES) as [name, px] (name)}
      <button class:active={cellSize === px} data-size={name} onclick={() => onSize(px)}>{name}</button>
    {/each}
    <input
      type="range"
      min={MIN_CELL}
      max={MAX_CELL}
      value={cellSize}
      aria-label={$t("writing.cellSize")}
      oninput={(e) => onSize(Number(e.currentTarget.value))}
    />
  </div>
  <span class="muted" data-testid="grid-shown">{shown}</span>
</div>
