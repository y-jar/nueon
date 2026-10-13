<!-- Canvas with typographic guides, the drawing surface and node overlay. -->
<script lang="ts">
  import type { GlyphContour, WritingConfig } from "../lib/api";
  import {
    cancelGesture,
    deleteSelection,
    editor,
    finishPath,
    pointerDown,
    pointerMove,
    pointerUp,
    redo,
    selectAll,
    setTool,
    toolHint,
    undo,
  } from "../lib/writingEditor.svelte";
  import {
    TOOLS,
    contourPathData,
    flipY,
    guideHeight,
    guideLines,
    outlinePathData,
  } from "../lib/writing";
  import { isContour } from "../lib/writingCommands";

  interface Props {
    config: WritingConfig;
  }

  let { config }: Props = $props();

  let svg: SVGSVGElement | undefined = $state();

  const guides = $derived(guideLines(config));
  const minX = -100;
  const maxX = $derived((config.upem || 1000) + 200);
  const storageMinY = $derived(Math.min(guideHeight(config, "descender"), -200) - 100);
  const storageMaxY = $derived(Math.max(guideHeight(config, "ascender"), 800) + 100);

  const viewBox = $derived(
    `${minX} ${-storageMaxY} ${(maxX - minX) / editor.zoom} ${(storageMaxY - storageMinY) / editor.zoom}`,
  );
  const d = $derived(editor.outline ? outlinePathData(editor.outline, true) : "");
  const previewD = $derived(
    editor.preview && editor.preview.kind === "contour"
      ? contourPathData(editor.preview as GlyphContour, true)
      : "",
  );
  const contours = $derived(
    editor.outline
      ? editor.outline.elements.flatMap((element, index) =>
          isContour(element) ? [{ element, index }] : [],
        )
      : [],
  );
  const handleScale = $derived(1 / editor.zoom);

  function isSelected(element: number, node: number): boolean {
    return editor.selection.some((s) => s.element === element && s.node === node);
  }

  /** Convert a pointer event to glyph (y-up) coordinates. */
  function toGlyph(event: PointerEvent): { x: number; y: number } {
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const local = pt.matrixTransform(ctm.inverse());
    return { x: local.x, y: flipY(local.y) };
  }

  function onDown(event: PointerEvent) {
    if (event.button !== 0) return;
    svg?.setPointerCapture(event.pointerId);
    svg?.parentElement?.focus();
    pointerDown(toGlyph(event), event.shiftKey);
  }

  function onMove(event: PointerEvent) {
    pointerMove(toGlyph(event));
  }

  function onUp(event: PointerEvent) {
    if (svg?.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    pointerUp(toGlyph(event));
  }

  function onKey(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    } else if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelection();
    } else if (event.key === "Enter") {
      finishPath();
    } else if (event.key === "Escape") {
      cancelGesture();
    } else if (!mod && !event.altKey) {
      const tool = TOOLS.find((t) => t.shortcut.toLowerCase() === event.key.toLowerCase());
      if (tool) setTool(tool.id);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="glyph-canvas"
  role="application"
  aria-label="Glyph canvas"
  tabindex="0"
  onkeydown={onKey}
>
  <svg
    bind:this={svg}
    class="canvas-svg"
    aria-hidden="true"
    {viewBox}
    preserveAspectRatio="xMidYMid meet"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    ondblclick={finishPath}
  >
    {#if editor.showGuides}
      {#each guides as guide (guide.key)}
        <line
          class="guide"
          class:dashed={guide.dashed}
          x1={minX}
          y1={flipY(guide.y)}
          x2={maxX}
          y2={flipY(guide.y)}
        />
      {/each}
    {/if}
    {#if d}<path class="outline" d={d} />{/if}
    {#if previewD}<path class="outline preview" d={previewD} />{/if}

    {#each contours as { element, index } (index)}
      {#each element.nodes as node, ni (ni)}
        {#if node.handle_in}
          <line
            class="handle-line"
            x1={node.x}
            y1={flipY(node.y)}
            x2={node.x + node.handle_in[0]}
            y2={flipY(node.y + node.handle_in[1])}
          />
          <circle
            class="handle"
            cx={node.x + node.handle_in[0]}
            cy={flipY(node.y + node.handle_in[1])}
            r={4 * handleScale}
          />
        {/if}
        {#if node.handle_out}
          <line
            class="handle-line"
            x1={node.x}
            y1={flipY(node.y)}
            x2={node.x + node.handle_out[0]}
            y2={flipY(node.y + node.handle_out[1])}
          />
          <circle
            class="handle"
            cx={node.x + node.handle_out[0]}
            cy={flipY(node.y + node.handle_out[1])}
            r={4 * handleScale}
          />
        {/if}
        <rect
          class="glyph-node"
          class:node-selected={isSelected(index, ni)}
          class:node-smooth={node.kind !== "corner"}
          x={node.x - 4 * handleScale}
          y={flipY(node.y) - 4 * handleScale}
          width={8 * handleScale}
          height={8 * handleScale}
          rx={node.kind === "corner" ? 0 : 4 * handleScale}
        />
      {/each}
    {/each}
  </svg>
  <div class="canvas-hint">{toolHint(editor.activeTool)}</div>
</div>
