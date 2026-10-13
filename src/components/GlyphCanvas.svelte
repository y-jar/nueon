<!-- Canvas with typographic guides, the drawing surface and node overlay. -->
<script lang="ts">
  import type { GlyphContour, WritingConfig } from "../lib/api";
  import {
    breakSelected,
    componentContours,
    expandSelectedComponent,
    cancelGesture,
    deleteNodes,
    editor,
    finishPath,
    joinNodes,
    nudge,
    pointerDown,
    pointerMove,
    pointerUp,
    redo,
    selectAll,
    selectNext,
    setGuideHeights,
    setTool,
    setZoom,
    toolHint,
    undo,
    type Modifiers,
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
  $effect(() => {
    setGuideHeights(guides.map((g) => ({ y: g.y, label: g.key.replace("_", " ") })));
  });
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
  const instances = $derived(
    editor.outline && editor.library
      ? componentContours().map(({ element, contours: parts }) => ({
          element,
          d: parts.map((c) => contourPathData(c, true)).join(" "),
        }))
      : [],
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

  const mods = (event: PointerEvent | KeyboardEvent | WheelEvent): Modifiers => ({
    shift: event.shiftKey,
    ctrl: event.ctrlKey || event.metaKey,
    alt: event.altKey,
  });

  let panning: { x: number; y: number } | null = null;
  let spaceDown = false;

  function onDown(event: PointerEvent) {
    svg?.setPointerCapture(event.pointerId);
    svg?.parentElement?.focus();
    if (event.button === 1 || (event.button === 0 && spaceDown)) {
      panning = { x: event.clientX, y: event.clientY };
      return;
    }
    if (event.button !== 0) return;
    pointerDown(toGlyph(event), mods(event));
  }

  function onMove(event: PointerEvent) {
    if (panning) {
      scroller?.scrollBy(panning.x - event.clientX, panning.y - event.clientY);
      panning = { x: event.clientX, y: event.clientY };
      return;
    }
    pointerMove(toGlyph(event), mods(event));
  }

  function onUp(event: PointerEvent) {
    if (svg?.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (panning) {
      panning = null;
      return;
    }
    pointerUp(toGlyph(event), mods(event));
  }

  /** Ctrl+wheel zooms by sqrt(2) per notch, like Inkscape. */
  function onWheel(event: WheelEvent) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    setZoom(editor.zoom * Math.SQRT2 ** (event.deltaY < 0 ? 1 : -1));
  }

  let scroller: HTMLElement | undefined = $state();

  function onKeyUp(event: KeyboardEvent) {
    if (event.key === " ") spaceDown = false;
  }

  function onKey(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === " ") {
      spaceDown = true;
      event.preventDefault();
    } else if (event.key.startsWith("Arrow") && !mod) {
      event.preventDefault();
      const dx = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      const dy = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
      nudge(dx, dy, event.shiftKey);
    } else if (event.key === "Tab") {
      event.preventDefault();
      selectNext(event.shiftKey ? -1 : 1);
    } else if (mod && event.shiftKey && event.key.toLowerCase() === "e") {
      event.preventDefault();
      expandSelectedComponent();
    } else if (event.shiftKey && !mod && event.key.toLowerCase() === "j") {
      joinNodes();
    } else if (event.shiftKey && !mod && event.key.toLowerCase() === "b") {
      breakSelected();
    } else if (event.key === "1" && !mod) {
      setZoom(1);
    } else if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setZoom(1);
    } else if (mod && event.key.toLowerCase() === "z") {
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
      deleteNodes(mod);
    } else if (event.key === "Enter") {
      finishPath();
    } else if (event.key === "Escape") {
      cancelGesture();
    } else if (!mod && !event.altKey && !event.shiftKey) {
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
  onkeyup={onKeyUp}
  onwheel={onWheel}
  bind:this={scroller}
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
    {#if editor.showGuides}
      <line class="guide edge" x1={0} y1={-storageMaxY} x2={0} y2={-storageMinY} />
      {#if editor.outline?.advance}
        <line
          class="guide edge"
          x1={editor.outline.advance}
          y1={-storageMaxY}
          x2={editor.outline.advance}
          y2={-storageMinY}
        />
      {/if}
    {/if}
    {#each instances as inst (inst.element)}
      <path
        class="component-instance"
        class:component-selected={editor.selectedComponent === inst.element}
        d={inst.d}
      />
    {/each}
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
    {#if editor.marquee}
      <rect
        class="marquee"
        x={Math.min(editor.marquee.a.x, editor.marquee.b.x)}
        y={flipY(Math.max(editor.marquee.a.y, editor.marquee.b.y))}
        width={Math.abs(editor.marquee.a.x - editor.marquee.b.x)}
        height={Math.abs(editor.marquee.a.y - editor.marquee.b.y)}
      />
    {/if}
    {#if editor.snapHit}
      {@const hit = editor.snapHit}
      {#each hit.hits as t (t.kind + t.label)}
        {#if t.kind === "guide"}
          <line class="snap-line" x1={minX} y1={flipY(t.y ?? 0)} x2={maxX} y2={flipY(t.y ?? 0)} />
        {:else if t.kind === "origin" || t.kind === "advance"}
          <line class="snap-line" x1={t.x} y1={-storageMaxY} x2={t.x} y2={-storageMinY} />
        {/if}
      {/each}
      {#if hit.locked}
        <circle
          class="snap-lock"
          class:weld={!!hit.weld}
          cx={hit.point.x}
          cy={flipY(hit.point.y)}
          r={(hit.weld ? 11 : 8) * handleScale}
        />
      {:else}
        <circle class="snap-dot" cx={hit.point.x} cy={flipY(hit.point.y)} r={3 * handleScale} />
      {/if}
    {/if}
  </svg>
  {#if editor.snapHit}
    <div class="snap-label" class:weld={!!editor.snapHit.weld}>
      {editor.snapHit.weld
        ? "release to weld"
        : editor.snapHit.hits.map((t) => t.label).join(" + ") || "grid"}
    </div>
  {/if}
  <div class="canvas-hint">{toolHint(editor.activeTool)}</div>
</div>
