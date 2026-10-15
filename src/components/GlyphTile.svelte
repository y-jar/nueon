<!-- One boxed grid cell: label above, the glyph's outline and advance box inside; or a faint X for an empty slot. -->
<script lang="ts">
  import type { GlyphOutline } from "../lib/api";
  import type { Cell } from "../lib/writingGrid";
  import { cellViewBox, previewOf } from "../lib/writingGrid";
  import type { GlyphLookup } from "../lib/writingComponents";

  interface Props {
    cell: Cell;
    outline: GlyphOutline | null | undefined;
    lookup: GlyphLookup;
    size: number;
    selected: boolean;
    ascender: number;
    descender: number;
    onSelect: () => void;
    onMenu: (event: MouseEvent) => void;
  }

  let { cell, outline, lookup, size, selected, ascender, descender, onSelect, onMenu }: Props =
    $props();

  const preview = $derived(cell.kind === "glyph" ? previewOf(outline, lookup) : null);
  const box = $derived(preview ? cellViewBox(preview.advance, ascender, descender) : null);
  const viewBox = $derived(box ? `${box.x} ${box.y} ${box.w} ${box.h}` : "0 0 10 10");
  const label = $derived(
    cell.kind === "glyph"
      ? cell.symbols.length > 0
        ? cell.symbols.join(" ")
        : cell.glyph.name
      : cell.phoneme.symbol,
  );
  const sub = $derived(cell.kind === "glyph" && cell.symbols.length > 0 ? cell.glyph.name : "");
</script>

<button
  class="glyph-tile"
  class:selected
  class:empty-slot={cell.kind === "empty"}
  class:undrawn={cell.kind === "glyph" && !cell.drawn}
  data-cell={cell.kind === "glyph" ? cell.glyph.id : `slot:${cell.phoneme.id ?? cell.phoneme.symbol}`}
  data-kind={cell.kind}
  style="width: {size}px"
  title={cell.kind === "glyph" ? cell.glyph.name : `${cell.phoneme.symbol} (no glyph yet)`}
  onclick={onSelect}
  oncontextmenu={(e) => {
    e.preventDefault();
    onMenu(e);
  }}
>
  <span class="glyph-label">
    <span class="glyph-name">{label}</span>
    {#if sub}<span class="glyph-symbols">{sub}</span>{/if}
  </span>
  <svg
    class="glyph-art"
    width={size}
    height={size}
    {viewBox}
    aria-hidden="true"
    preserveAspectRatio={cell.kind === "empty" ? "none" : "xMidYMid meet"}
  >
    {#if cell.kind === "empty"}
      <g class="empty-x">
        <line x1="0" y1="0" x2="10" y2="10" />
        <line x1="0" y1="10" x2="10" y2="0" />
      </g>
    {:else if preview && box}
      <rect class="cell-advance" x={0} y={box.y} width={preview.advance} height={box.h} />
      <line class="cell-baseline" x1={box.x} y1={0} x2={box.x + box.w} y2={0} />
      {#if preview.drawn}<path class="cell-ink" d={preview.d} />{/if}
    {/if}
  </svg>
</button>
