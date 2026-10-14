<!-- Canvas with typographic guides, the drawing surface and node overlay. -->
<script lang="ts">
  import { untrack } from "svelte";
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
    setGuideMetrics,
    setCanvasSize,
    currentViewBox,
    currentPivot,
    currentTransformBox,
    duplicateSelection,
    openTransformDialog,
    lookupGlyph,
    previewOutline,
    effectiveTool,
    fitGlyph,
    holdTool,
    setTool,
    zoomActual,
    zoomStep,
    toolHint,
    undo,
    type Modifiers,
  } from "../lib/writingEditor.svelte";
  import {
    toolByKey,
    contourPathData,
    flipY,
    guideHeight,
    guideLines,
    outlinePathData,
  } from "../lib/writing";
  import { isContour } from "../lib/writingCommands";
  import { elementPathBounds } from "../lib/writingSelect";
  import { measuredSize } from "../lib/writingViewport";

  interface Props {
    config: WritingConfig;
  }

  let { config }: Props = $props();

  let svg: SVGSVGElement | undefined = $state();

  const guides = $derived(guideLines(config));
  $effect(() => {
    setGuideHeights(guides.map((g) => ({ y: g.y, label: g.key.replace("_", " ") })));
  });

  const box = $derived(currentViewBox());
  const viewBox = $derived(`${box.x} ${box.y} ${box.width} ${box.height}`);
  const minX = $derived(box.x);
  const maxX = $derived(box.x + box.width);
  const storageMinY = $derived(-(box.y + box.height));
  const storageMaxY = $derived(-box.y);
  $effect(() => {
    setGuideMetrics({
      ascender: guideHeight(config, "ascender"),
      descender: guideHeight(config, "descender"),
      advance: editor.outline?.advance ?? config.upem * 0.6,
    });
  });
  const shown = $derived(previewOutline());
  const d = $derived(shown ? outlinePathData(shown, true) : "");
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
  const tbox = $derived(editor.liveMatrix ? null : currentTransformBox());
  const pivot = $derived(editor.liveMatrix ? null : currentPivot());
  const showTransformBox = $derived(
    !!tbox && editor.elements.length > 0 && effectiveTool() === "select",
  );
  const selectedBoxes = $derived(
    editor.outline
      ? editor.elements.flatMap((index) => {
          const b = elementPathBounds(editor.outline!, index, lookupGlyph);
          return b
            ? [{ index, x: b.minX, y: flipY(b.maxY), w: b.maxX - b.minX, h: b.maxY - b.minY }]
            : [];
        })
      : [],
  );

  function isSelected(element: number, node: number): boolean {
    return editor.selection.some((s) => s.element === element && s.node === node);
  }

  /** The pointer in canvas pixels and in glyph (y-up) coordinates, from the live view. */
  function locate(event: { clientX: number; clientY: number }) {
    const rect = svg?.getBoundingClientRect();
    const sx = event.clientX - (rect?.left ?? 0);
    const sy = event.clientY - (rect?.top ?? 0);
    return {
      screen: { x: sx, y: sy },
      glyph: {
        x: editor.view.cx + (sx - editor.canvasSize.width / 2) / editor.view.scale,
        y: editor.view.cy - (sy - editor.canvasSize.height / 2) / editor.view.scale,
      },
    };
  }

  const mods = (
    event: PointerEvent | KeyboardEvent | WheelEvent,
    screen?: { x: number; y: number },
  ): Modifiers => ({
    shift: event.shiftKey,
    ctrl: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    screen,
    button: "button" in event ? event.button : 0,
  });

  let spaceDown = false;

  function onDown(event: PointerEvent) {
    svg?.setPointerCapture(event.pointerId);
    svg?.parentElement?.focus();
    if (event.button !== 0 && event.button !== 1) return;
    const at = locate(event);
    if (spaceDown && event.button === 0) {
      pointerDown(at.glyph, { ...mods(event, at.screen), button: 1 });
      return;
    }
    pointerDown(at.glyph, mods(event, at.screen));
  }

  function onMove(event: PointerEvent) {
    const at = locate(event);
    pointerMove(at.glyph, mods(event, at.screen));
  }

  function onUp(event: PointerEvent) {
    if (svg?.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    const at = locate(event);
    pointerUp(at.glyph, mods(event, at.screen));
  }

  /** Ctrl+wheel zooms about the cursor by sqrt(2) per notch, like Inkscape. */
  function onWheel(event: WheelEvent) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    zoomStep(Math.SQRT2 ** (event.deltaY < 0 ? 1 : -1), locate(event).screen);
  }

  let scroller: HTMLElement | undefined = $state();

  $effect(() => {
    if (!scroller) return;
    const target = scroller;
    const measure = () => {
      const r = target.getBoundingClientRect();
      setCanvasSize(measuredSize(r, 2));
    };
    untrack(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  });

  function onKeyUp(event: KeyboardEvent) {
    if (event.key === " ") {
      spaceDown = false;
      holdTool(null);
    }
  }

  function onKey(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === " ") {
      spaceDown = true;
      holdTool("hand");
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
      zoomActual();
    } else if (event.key === "0" && !mod) {
      fitGlyph();
    } else if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      fitGlyph();
    } else if (mod && event.shiftKey && event.key.toLowerCase() === "m") {
      event.preventDefault();
      openTransformDialog();
    } else if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelection();
    } else if (event.shiftKey && !mod && event.key.toLowerCase() === "h") {
      editor.showAllHandles = !editor.showAllHandles;
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
      const tool = toolByKey(event.key);
      if (tool) setTool(tool);
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
    class="canvas-svg tool-{effectiveTool()}"
    data-hover={editor.hoverHandle ?? ""}
    class:panning={editor.tempTool === "hand"}
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
        {#if node.kind === "symmetric"}
          <polygon
            class="glyph-node node-symmetric"
            class:node-selected={isSelected(index, ni)}
            data-kind="symmetric"
            points="{node.x},{flipY(node.y) - 5.5 * handleScale} {node.x + 5.5 * handleScale},{flipY(node.y)} {node.x},{flipY(node.y) + 5.5 * handleScale} {node.x - 5.5 * handleScale},{flipY(node.y)}"
          />
        {:else}
          <rect
            class="glyph-node"
            class:node-selected={isSelected(index, ni)}
            class:node-smooth={node.kind !== "corner"}
            data-kind={node.kind}
            x={node.x - 4 * handleScale}
            y={flipY(node.y) - 4 * handleScale}
            width={8 * handleScale}
            height={8 * handleScale}
            rx={node.kind === "corner" ? 0 : 4 * handleScale}
          />
        {/if}
      {/each}
    {/each}
    {#each selectedBoxes as sb (sb.index)}
      <rect
        class="element-selection"
        x={sb.x}
        y={sb.y}
        width={sb.w}
        height={sb.h}
      />
    {/each}
    {#if showTransformBox && tbox && pivot}
      <rect
        class="transform-box"
        x={tbox.minX}
        y={flipY(tbox.maxY)}
        width={tbox.maxX - tbox.minX}
        height={tbox.maxY - tbox.minY}
      />
      {#each [
        { w: "nw", x: tbox.minX, y: tbox.maxY },
        { w: "ne", x: tbox.maxX, y: tbox.maxY },
        { w: "sw", x: tbox.minX, y: tbox.minY },
        { w: "se", x: tbox.maxX, y: tbox.minY },
      ] as h (h.w)}
        <rect
          class="transform-handle scale"
          data-handle={h.w}
          x={h.x - 5 * handleScale}
          y={flipY(h.y) - 5 * handleScale}
          width={10 * handleScale}
          height={10 * handleScale}
        />
      {/each}
      {#each [
        { w: "n", x: (tbox.minX + tbox.maxX) / 2, y: tbox.maxY },
        { w: "s", x: (tbox.minX + tbox.maxX) / 2, y: tbox.minY },
        { w: "e", x: tbox.maxX, y: (tbox.minY + tbox.maxY) / 2 },
        { w: "w", x: tbox.minX, y: (tbox.minY + tbox.maxY) / 2 },
      ] as h (h.w)}
        <circle
          class="transform-handle skew"
          data-handle={h.w}
          cx={h.x}
          cy={flipY(h.y)}
          r={5 * handleScale}
        />
      {/each}
      <g class="transform-pivot" data-handle="pivot">
        <circle cx={pivot.x} cy={flipY(pivot.y)} r={6 * handleScale} />
        <line x1={pivot.x - 9 * handleScale} y1={flipY(pivot.y)} x2={pivot.x + 9 * handleScale} y2={flipY(pivot.y)} />
        <line x1={pivot.x} y1={flipY(pivot.y) - 9 * handleScale} x2={pivot.x} y2={flipY(pivot.y) + 9 * handleScale} />
      </g>
    {/if}
    {#if editor.zoomBox}
      <rect
        class="marquee zoom-box"
        x={Math.min(editor.zoomBox.a.x, editor.zoomBox.b.x)}
        y={flipY(Math.max(editor.zoomBox.a.y, editor.zoomBox.b.y))}
        width={Math.abs(editor.zoomBox.a.x - editor.zoomBox.b.x)}
        height={Math.abs(editor.zoomBox.a.y - editor.zoomBox.b.y)}
      />
    {/if}
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
