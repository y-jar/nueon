<!-- The glyph grid: boxed cells in a virtualised scroller, with empty slots for sounds that have no glyph. -->
<script lang="ts">
  import { untrack } from "svelte";
  import { t } from "svelte-i18n";
  import type { GlyphMeta, GlyphOutline, Phoneme } from "../lib/api";
  import GlyphTile from "./GlyphTile.svelte";
  import { LABEL_HEIGHT, gridLayout, visibleRows, type Cell } from "../lib/writingGrid";
  import type { GlyphLookup } from "../lib/writingComponents";

  interface Props {
    cells: Cell[];
    outlineOf: (id: string) => GlyphOutline | null | undefined;
    lookup: GlyphLookup;
    cellSize: number;
    selectedId: string | null;
    ascender: number;
    descender: number;
    version: number;
    onVisible: (ids: string[]) => void;
    onSelect: (glyph: GlyphMeta) => void;
    onCreate: (phoneme: Phoneme) => void;
    onMenu: (event: MouseEvent, glyph: GlyphMeta) => void;
  }

  let {
    cells,
    outlineOf,
    lookup,
    cellSize,
    selectedId,
    ascender,
    descender,
    version,
    onVisible,
    onSelect,
    onCreate,
    onMenu,
  }: Props = $props();

  const GAP = 8;
  const OVERSCAN = 2;

  let scroller = $state<HTMLDivElement | null>(null);
  let width = $state(0);
  let height = $state(0);
  let scrollTop = $state(0);

  const layout = $derived(gridLayout(cells.length, width, cellSize, GAP));
  const window = $derived(visibleRows(scrollTop, height, layout.rowHeight, layout.rows, OVERSCAN));
  const shown = $derived(
    window.last < window.first
      ? []
      : cells
          .slice(window.first * layout.cols, (window.last + 1) * layout.cols)
          .map((cell, i) => ({ cell, index: window.first * layout.cols + i })),
  );

  $effect(() => {
    if (!scroller) return;
    const target = scroller;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const w = Math.round(target.clientWidth);
      const h = Math.round(target.clientHeight);
      if (w !== untrack(() => width)) width = w;
      if (h !== untrack(() => height)) height = h;
    };
    untrack(measure);
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(measure);
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  });

  $effect(() => {
    const ids = shown.flatMap(({ cell }) => (cell.kind === "glyph" ? [cell.glyph.id] : []));
    onVisible(ids);
  });

  function onScroll() {
    if (!scroller) return;
    const top = Math.round(scroller.scrollTop);
    if (top !== scrollTop) scrollTop = top;
  }

  const gridHeight = $derived(layout.rows * layout.rowHeight);

  const outlines = $derived.by(() => {
    void version;
    const map: Record<string, GlyphOutline | null | undefined> = {};
    for (const { cell } of shown) if (cell.kind === "glyph") map[cell.glyph.id] = outlineOf(cell.glyph.id);
    return map;
  });
</script>

{#if cells.length === 0}
  <p class="muted">{$t("writing.noMatches")}</p>
{:else}
  <div
    class="glyph-scroller"
    data-testid="glyph-grid"
    data-rows={layout.rows}
    data-cols={layout.cols}
    data-rendered={shown.length}
    bind:this={scroller}
    onscroll={onScroll}
  >
    <div class="glyph-grid-canvas" style="height: {gridHeight}px">
      {#each shown as { cell, index } (cell.kind === "glyph" ? cell.glyph.id : `slot:${cell.phoneme.id ?? cell.phoneme.symbol}`)}
        {@const row = Math.floor(index / layout.cols)}
        {@const col = index % layout.cols}
        <div
          class="glyph-cell-pos"
          style="transform: translate({col * (cellSize + GAP)}px, {row * layout.rowHeight}px); width: {cellSize}px; height: {cellSize + LABEL_HEIGHT}px"
        >
          <GlyphTile
            {cell}
            outline={cell.kind === "glyph" ? outlines[cell.glyph.id] : null}
            {lookup}
            size={cellSize}
            selected={cell.kind === "glyph" && cell.glyph.id === selectedId}
            {ascender}
            {descender}
            onSelect={() => (cell.kind === "glyph" ? onSelect(cell.glyph) : onCreate(cell.phoneme))}
            onMenu={(e) => cell.kind === "glyph" && onMenu(e, cell.glyph)}
          />
        </div>
      {/each}
    </div>
  </div>
{/if}
