<!-- One boxed grid cell: label above, the glyph's outline and advance box inside; or a faint X for an empty slot. -->
<script lang="ts">
  import type { GlyphOutline } from "../lib/api";
  import type { Cell } from "../lib/writingGrid";
  import { cellViewBox, previewOf } from "../lib/writingGrid";
  import type { GlyphLookup } from "../lib/writingComponents";
  import { bearingsOf, cellEdgeHit, inkBounds, type BearingLine } from "../lib/writingSpacing";

  interface Props {
    cell: Cell;
    outline: GlyphOutline | null | undefined;
    lookup: GlyphLookup;
    size: number;
    selected: boolean;
    ascender: number;
    descender: number;
    onSelect: (additive: boolean) => void;
    batched?: boolean;
    onMenu: (event: MouseEvent) => void;
    /** Spacing mode: edges can be dragged; the parent owns the gesture and the undo step. */
    spacing?: boolean;
    onEdgeStart?: (line: BearingLine, px: number) => void;
    onEdgeMove?: (px: number) => void;
    onEdgeEnd?: () => void;
  }

  let {
    cell,
    outline,
    lookup,
    size,
    selected,
    ascender,
    descender,
    onSelect,
    batched = false,
    onMenu,
    spacing = false,
    onEdgeStart,
    onEdgeMove,
    onEdgeEnd,
  }: Props = $props();

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
  const ink = $derived(cell.kind === "glyph" && outline ? inkBounds(outline, lookup) : null);
  const bearings = $derived(cell.kind === "glyph" && outline ? bearingsOf(outline, lookup) : null);
  let art = $state<SVGSVGElement | null>(null);
  let dragging = $state<BearingLine | null>(null);
  let hoverEdge = $state<BearingLine | null>(null);

  function px(event: PointerEvent): number {
    const r = art?.getBoundingClientRect();
    return event.clientX - (r?.left ?? 0);
  }

  function onDown(event: PointerEvent) {
    if (!spacing || cell.kind !== "glyph" || !outline || !box) return;
    const line = cellEdgeHit(outline, { x: box.x, w: box.w }, size, px(event), lookup);
    if (!line) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = line;
    try {
      art?.setPointerCapture(event.pointerId);
    } catch {
      // a synthetic or already-ended pointer has nothing to capture; the drag still works
    }
    onEdgeStart?.(line, px(event));
  }

  function onMove(event: PointerEvent) {
    if (!spacing || cell.kind !== "glyph" || !outline || !box) return;
    if (dragging) {
      onEdgeMove?.(px(event));
      return;
    }
    const line = cellEdgeHit(outline, { x: box.x, w: box.w }, size, px(event), lookup);
    if (line !== hoverEdge) hoverEdge = line;
  }

  function onUp(event: PointerEvent) {
    if (!dragging) return;
    try {
      if (art?.hasPointerCapture(event.pointerId)) art.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    dragging = null;
    onEdgeEnd?.();
  }

  const sub = $derived(cell.kind === "glyph" && cell.symbols.length > 0 ? cell.glyph.name : "");
</script>

<button
  class="glyph-tile"
  class:selected
  class:batched
  class:empty-slot={cell.kind === "empty"}
  class:undrawn={cell.kind === "glyph" && !cell.drawn}
  data-cell={cell.kind === "glyph" ? cell.glyph.id : `slot:${cell.phoneme.id ?? cell.phoneme.symbol}`}
  data-kind={cell.kind}
  style="width: {size}px"
  title={cell.kind === "glyph" ? cell.glyph.name : `${cell.phoneme.symbol} (no glyph yet)`}
  onclick={(e) => onSelect(e.shiftKey || e.ctrlKey || e.metaKey)}
  oncontextmenu={(e) => {
    e.preventDefault();
    onMenu(e);
  }}
>
  <span class="glyph-label">
    <span class="glyph-name">{label}</span>
    {#if sub}<span class="glyph-symbols">{sub}</span>{/if}
    {#if spacing && bearings}
      <span class="glyph-bearings mono" data-testid="cell-bearings">
        {bearings.lsb === null ? "-" : Math.round(bearings.lsb)}|{bearings.rsb === null ? "-" : Math.round(bearings.rsb)}
      </span>
    {/if}
  </span>
  <svg
    bind:this={art}
    class="glyph-art"
    class:spacing-art={spacing && cell.kind === "glyph"}
    data-edge-hover={hoverEdge ?? ""}
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onUp}
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
      {#if spacing && ink}
        <line
          class="cell-edge"
          class:cell-edge-active={dragging === "lsb" || hoverEdge === "lsb"}
          data-edge="lsb"
          x1={ink.minX}
          y1={box.y}
          x2={ink.minX}
          y2={box.y + box.h}
        />
      {/if}
      {#if spacing}
        <line
          class="cell-edge"
          class:cell-edge-active={dragging === "advance" || hoverEdge === "advance"}
          data-edge="advance"
          x1={preview.advance}
          y1={box.y}
          x2={preview.advance}
          y2={box.y + box.h}
        />
      {/if}
    {/if}
  </svg>
</button>
