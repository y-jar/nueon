<!-- Canvas with typographic guides, the drawing surface and node overlay. -->
<script lang="ts">
  import { untrack } from "svelte";
  import type { GlyphContour, WritingConfig } from "../lib/api";
  import {
    breakSelected,
    componentContours,
    expandSelectedComponent,
    cancelGesture,
    clearBackImage,
    currentBackRect,
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
    addExtremaToSelection,
    currentPivot,
    currentTransformBox,
    duplicateSelection,
    openTransformDialog,
    lookupGlyph,
    currentSpacing,
    previewOutline,
    setCursor,
    toggleNodeAt,
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
  import { backRectCorners } from "../lib/writingLayers";
  import { elementPathBounds } from "../lib/writingSelect";
  import { measuredSize } from "../lib/writingViewport";
  import { segmentPathData, visibleHandles } from "../lib/writingBezier";
  import { contourDirection, contourStart, guideLabelPlacement, handleMarkLines, openEnds } from "../lib/writingInfo";

  interface Props {
    config: WritingConfig;
  }

  let { config }: Props = $props();

  let svg: SVGSVGElement | undefined = $state();

  const guides = $derived(guideLines(config));
  const backRect = $derived(currentBackRect());
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
  const shownHandles = $derived(
    editor.outline && effectiveTool() !== "select"
      ? visibleHandles(editor.outline, editor.selection, editor.showAllHandles)
      : [],
  );
  const handleDots = $derived(
    shownHandles.flatMap((h) => {
      const el = editor.outline!.elements[h.ref.element];
      if (!el || el.kind !== "contour") return [];
      const n = el.nodes[h.ref.node];
      const off = h.which === "in" ? n.handle_in : n.handle_out;
      if (!n || !off) return [];
      return [{
        key: `${h.ref.element}:${h.ref.node}:${h.which}`,
        which: h.which,
        nx: n.x,
        ny: n.y,
        hx: n.x + off[0],
        hy: n.y + off[1],
      }];
    }),
  );
  const hoverSegmentD = $derived.by(() => {
    const h = editor.hover;
    if (!h || h.kind !== "segment" || !editor.outline) return "";
    const [, e, sg] = h.key.split(":");
    const el = editor.outline.elements[Number(e)];
    if (!el || el.kind !== "contour") return "";
    const a = el.nodes[Number(sg)];
    const b = el.nodes[(Number(sg) + 1) % el.nodes.length];
    return a && b ? segmentPathData(a, b, true) : "";
  });
  const contourMarks = $derived(
    shown
      ? shown.elements.flatMap((el, index) => {
          if (el.kind !== "contour") return [];
          const start = contourStart(el);
          const dir = contourDirection(el);
          return [{ index, start, dir, ends: openEnds(el).map((i) => ({ i, n: el.nodes[i] })) }];
        })
      : [],
  );
  const spacingNow = $derived((editor.outline, currentSpacing()));
  const advanceX = $derived(spacingNow?.advance ?? null);
  const inkLeft = $derived(spacingNow && spacingNow.lsb !== null ? spacingNow.lsb : null);
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

  function onDouble(event: MouseEvent) {
    if (effectiveTool() === "direct") toggleNodeAt(locate(event).glyph);
    else finishPath();
  }

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
    } else if (mod && event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      addExtremaToSelection();
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
      if (editor.imageSelected && editor.selection.length === 0 && editor.elements.length === 0) {
        clearBackImage();
      } else {
        deleteNodes(mod);
      }
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
    data-bearing-hover={editor.hoverBearing ?? ""}
    class:panning={editor.tempTool === "hand"}
    aria-hidden="true"
    {viewBox}
    preserveAspectRatio="xMidYMid meet"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerleave={() => setCursor(null)}
    onpointerup={onUp}
    ondblclick={onDouble}
  >
    {#if editor.layers.back && backRect && editor.backImage}
      <image
        class="back-image"
        data-back-image
        href={editor.backImage.url}
        x={backRect.x}
        y={flipY(backRect.y + backRect.h)}
        width={backRect.w}
        height={backRect.h}
        preserveAspectRatio="none"
      />
      {#if editor.imageSelected}
        <rect
          class="image-box"
          x={backRect.x}
          y={flipY(backRect.y + backRect.h)}
          width={backRect.w}
          height={backRect.h}
        />
        {#each Object.entries(backRectCorners(backRect)) as [id, corner] (id)}
          <circle
            class="image-handle"
            data-image-handle={id}
            cx={corner.x}
            cy={flipY(corner.y)}
            r={6 * handleScale}
          />
        {/each}
      {/if}
    {/if}
    {#if editor.layers.guide}
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
    {#if editor.layers.guide}
      {#each guides as guide (guide.key)}
        {@const label = guideLabelPlacement(guide.key, guide.y, minX)}
        <text
          class="guide-label"
          x={label.x + 4 * handleScale}
          y={flipY(guide.y) - 3 * handleScale}
          font-size={11 * handleScale}
        >{label.text}</text>
      {/each}
      {#if inkLeft !== null}
        <line
          class="bearing-line"
          class:bearing-active={editor.hoverBearing === "lsb"}
          data-bearing="lsb"
          x1={inkLeft}
          y1={-storageMaxY}
          x2={inkLeft}
          y2={-storageMinY}
        />
        <text class="guide-label" x={inkLeft + 4 * handleScale} y={-storageMaxY + 28 * handleScale} font-size={11 * handleScale}>
          lsb {Math.round(spacingNow?.lsb ?? 0)}
        </text>
      {/if}
      {#if advanceX && advanceX > 0}
        <line
          class="bearing-line"
          class:bearing-active={editor.hoverBearing === "advance"}
          data-bearing="advance"
          x1={advanceX}
          y1={-storageMaxY}
          x2={advanceX}
          y2={-storageMinY}
        />
        {#if spacingNow && spacingNow.rsb !== null}
          <text
            class="guide-label"
            x={advanceX - 4 * handleScale}
            y={-storageMaxY + 28 * handleScale}
            font-size={11 * handleScale}
            text-anchor="end"
          >rsb {Math.round(spacingNow.rsb)}</text>
        {/if}
        <rect
          class="advance-box"
          x={0}
          y={-storageMaxY}
          width={advanceX}
          height={storageMaxY - storageMinY}
        />
        <text
          class="guide-label"
          x={advanceX - 4 * handleScale}
          y={-storageMaxY + 14 * handleScale}
          font-size={11 * handleScale}
          text-anchor="end"
        >advance {Math.round(advanceX)}</text>
      {/if}
      <text
        class="guide-label"
        x={4 * handleScale}
        y={-storageMaxY + 14 * handleScale}
        font-size={11 * handleScale}
      >0</text>
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
    {#if editor.layers.fore}
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
        {@const hovered = editor.hover?.key === `n:${index}:${ni}`}
        {@const r = (hovered ? 7 : 5) * handleScale}
        {#if node.kind === "symmetric"}
          <polygon
            class="glyph-node node-symmetric"
            class:node-selected={isSelected(index, ni)}
            class:node-hover={hovered}
            data-kind="symmetric"
            points="{node.x},{flipY(node.y) - 1.2 * r} {node.x + 1.2 * r},{flipY(node.y)} {node.x},{flipY(node.y) + 1.2 * r} {node.x - 1.2 * r},{flipY(node.y)}"
          />
        {:else}
          <rect
            class="glyph-node"
            class:node-selected={isSelected(index, ni)}
            class:node-smooth={node.kind !== "corner"}
            class:node-hover={hovered}
            data-kind={node.kind}
            x={node.x - r}
            y={flipY(node.y) - r}
            width={2 * r}
            height={2 * r}
            rx={node.kind === "corner" ? 0 : r}
          />
        {/if}
        {#if node.kind !== "corner"}
          {#each handleMarkLines("plus", { x: node.x, y: flipY(node.y) }, 3 * handleScale) as ln, li (li)}
            <line
              class="node-cross"
              class:node-cross-selected={isSelected(index, ni)}
              x1={ln.x1}
              y1={ln.y1}
              x2={ln.x2}
              y2={ln.y2}
            />
          {/each}
        {/if}
      {/each}
    {/each}
    {#each contourMarks as mark (mark.index)}
      {#if mark.start}
        {@const ax = mark.start.x}
        {@const ay = flipY(mark.start.y)}
        {@const ux = mark.start.dx}
        {@const uy = -mark.start.dy}
        {@const len = 16 * handleScale}
        <g class="start-arrow" data-start={mark.index} data-direction={mark.dir ?? "open"}>
          <line x1={ax} y1={ay} x2={ax + ux * len} y2={ay + uy * len} />
          <polygon
            points="{ax + ux * len},{ay + uy * len} {ax + ux * len - ux * 6 * handleScale - uy * 3.5 * handleScale},{ay + uy * len - uy * 6 * handleScale + ux * 3.5 * handleScale} {ax + ux * len - ux * 6 * handleScale + uy * 3.5 * handleScale},{ay + uy * len - uy * 6 * handleScale - ux * 3.5 * handleScale}"
          />
        </g>
      {/if}
      {#each mark.ends as end (end.i)}
        <circle
          class="open-end"
          data-open-end={`${mark.index}:${end.i}`}
          cx={end.n.x}
          cy={flipY(end.n.y)}
          r={9 * handleScale}
        />
      {/each}
    {/each}
    {#if editor.spots.length > 0}
      {#each editor.spots as spot (spot.t)}
        <circle
          class="clean-spot"
          class:clean-spot-active={editor.spotAt?.t === spot.t}
          data-spot={spot.label}
          cx={spot.point.x}
          cy={flipY(spot.point.y)}
          r={(editor.spotAt?.t === spot.t ? 7 : 4.5) * handleScale}
        />
      {/each}
    {/if}
    {#if hoverSegmentD}<path class="segment-hover" d={hoverSegmentD} />{/if}
    {#each handleDots as hd (hd.key)}
      {@const hovered = editor.hover?.key === `h:${hd.key}`}
      <line
        class="handle-line handle-{hd.which}"
        x1={hd.nx}
        y1={flipY(hd.ny)}
        x2={hd.hx}
        y2={flipY(hd.hy)}
      />
      <circle
        class="handle handle-{hd.which}"
        class:handle-hover={hovered}
        data-handle-dot={hd.key}
        cx={hd.hx}
        cy={flipY(hd.hy)}
        r={(hovered ? 6 : 4) * handleScale}
      />
      {#each handleMarkLines("x", { x: hd.hx, y: flipY(hd.hy) }, (hovered ? 4 : 3) * handleScale) as ln, li (li)}
        <line class="handle-x handle-{hd.which}" x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2} />
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
    {/if}
    {#if editor.measureLine}
      {@const m = editor.measureLine}
      <line
        class="measure-line"
        data-measure
        x1={m.from.x}
        y1={flipY(m.from.y)}
        x2={m.to.x}
        y2={flipY(m.to.y)}
      />
      <circle class="measure-dot" data-measure cx={m.from.x} cy={flipY(m.from.y)} r={4 * handleScale} />
      <circle class="measure-dot" data-measure cx={m.to.x} cy={flipY(m.to.y)} r={4 * handleScale} />
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
        {:else if t.kind === "align" && t.from}
          {#if t.x !== undefined}
            <line class="align-line" x1={t.x} y1={-storageMaxY} x2={t.x} y2={-storageMinY} />
          {:else if t.y !== undefined}
            <line class="align-line" x1={minX} y1={flipY(t.y)} x2={maxX} y2={flipY(t.y)} />
          {/if}
          <circle class="align-from" cx={t.from.x} cy={flipY(t.from.y)} r={4 * handleScale} />
        {:else if t.kind === "angle" && t.from}
          {@const ux = /135/.test(t.label) ? -1 : 1}
          <line
            class="align-line"
            x1={t.from.x - ux * 4000}
            y1={flipY(t.from.y - 4000)}
            x2={t.from.x + ux * 4000}
            y2={flipY(t.from.y + 4000)}
          />
          <circle class="align-from" cx={t.from.x} cy={flipY(t.from.y)} r={4 * handleScale} />
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
  {#if editor.spotAt}
    <div class="snap-label spot-label" data-testid="spot-label">add node at {editor.spotAt.label}</div>
  {:else if editor.snapHit}
    <div class="snap-label" class:weld={!!editor.snapHit.weld}>
      {editor.snapHit.weld
        ? "release to weld"
        : editor.snapHit.hits.map((t) => t.label).join(" + ") || "grid"}
    </div>
  {/if}
  <div class="canvas-hint">{toolHint(editor.activeTool)}</div>
</div>
