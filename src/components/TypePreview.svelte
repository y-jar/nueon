<!-- Type preview: text set in the writing system's own font, shaped with the same engine and rules as the export. -->
<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import type { GlyphMeta, GlyphOutline, Phoneme, WritingConfig } from "../lib/api";
  import { contourPathData, guideHeight } from "../lib/writing";
  import { flattenElements, type GlyphLookup } from "../lib/writingComponents";
  import {
    MAX_SIZE,
    MIN_SIZE,
    clampSize,
    glyphPlacements,
    lineMetrics,
    linesFor,
    sampleText,
    scaleOf,
    textFor,
    wrapRuns,
    gapAt,
    gapDragEdits,
    type GapMode,
    type GapTarget,
    type ShapedRun,
  } from "../lib/typePreview";
  import { bearingsOf, setLeftBearing, setRightBearing } from "../lib/writingSpacing";

  interface Props {
    config: WritingConfig;
    phonemes: Phoneme[];
    glyphs: GlyphMeta[];
    outlineOf: (id: string) => GlyphOutline | null | undefined;
    lookup: GlyphLookup;
    version: number;
    words: string[];
    /** Apply a spacing change to one or two glyphs as a single step; the parent saves and records undo. */
    onSpacing: (label: string, before: Record<string, GlyphOutline>, after: Record<string, GlyphOutline>) => void;
    onLive: (id: string, outline: GlyphOutline) => void;
  }

  let { config, phonemes, glyphs, outlineOf, lookup, version, words, onSpacing, onLive }: Props = $props();

  type Source = "custom" | "words" | "all" | "pairs";

  let size = $state(64);
  let source = $state<Source>("custom");
  let custom = $state("");
  let picked = $state<string[]>([]);
  let wordFilter = $state("");
  let showMetrics = $state(true);
  let showBoxes = $state(false);
  let wrap = $state(true);
  let error = $state("");
  let key = $state("");
  let ids = $state<string[]>([]);
  let runs = $state<ShapedRun[]>([]);
  let width = $state(0);
  let host = $state<HTMLDivElement | null>(null);

  const rtl = $derived(config.direction === "rtl");
  const ascender = $derived(guideHeight(config, "ascender"));
  const descender = $derived(guideHeight(config, "descender"));
  const text = $derived(
    textFor(
      sampleText(
        { source, custom, words: picked } as Parameters<typeof sampleText>[0],
        glyphs,
        phonemes,
      ),
    ),
  );
  const lines = $derived(linesFor(text));
  const visibleWords = $derived(
    words.filter((w) => w.toLowerCase().includes(wordFilter.trim().toLowerCase())).slice(0, 200),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;

  async function shapeNow(forLines: string[], forRtl: boolean) {
    const mine = ++sequence;
    try {
      const result = await api.writingPreviewShape(forLines, forRtl);
      if (mine !== sequence) return;
      key = result.key;
      ids = result.glyph_ids;
      runs = result.runs;
      error = "";
    } catch (e) {
      if (mine !== sequence) return;
      error = String(e);
      runs = [];
    }
  }

  $effect(() => {
    const l = lines;
    const r = rtl;
    void version;
    untrack(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void shapeNow(l, r), 120);
    });
  });
  onDestroy(() => clearTimeout(timer));

  $effect(() => {
    if (!host) return;
    const target = host;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const w = Math.round(target.clientWidth);
      if (w !== untrack(() => width)) width = w;
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

  // Glyph path data per font glyph id, in font units, y-flipped for SVG.
  const paths = $derived.by(() => {
    void version;
    const out: Record<number, string> = {};
    ids.forEach((id, gid) => {
      if (!id) return;
      const outline = outlineOf(id);
      if (!outline) return;
      let d = "";
      for (const el of outline.elements) {
        if (el.kind === "contour" && el.nodes.length >= 2) d += contourPathData(el, true);
      }
      for (const flat of flattenElements(outline, lookup)) {
        for (const c of flat.contours) if (c.nodes.length >= 2) d += contourPathData(c, true);
      }
      out[gid] = d;
    });
    return out;
  });

  const scale = $derived(scaleOf(size, config.upem || 1000));
  const rows = $derived.by(() =>
    runs.flatMap((run, line) =>
      run.glyphs.length === 0
        ? [{ line, run, blank: true }]
        : (wrap ? wrapRuns(run, scale, Math.max(width - 24, size)) : [run]).map((r) => ({
            line,
            run: r,
            blank: false,
          })),
    ),
  );

  function togglePicked(word: string) {
    picked = picked.includes(word) ? picked.filter((w) => w !== word) : [...picked, word];
  }

  const SOURCES: Source[] = ["custom", "words", "all", "pairs"];

  // -- bearing-adjust drag: grab the gap between two letters --------------------
  let adjust = $state(false);
  let gapMode = $state<GapMode>("split");
  let hoverGap = $state<{ row: number; gap: GapTarget } | null>(null);
  type GapDrag = {
    row: number;
    gap: GapTarget;
    startX: number;
    leftId: string;
    rightId: string;
    leftBase: GlyphOutline;
    rightBase: GlyphOutline;
    last: Record<string, GlyphOutline>;
  };
  let gapDrag: GapDrag | null = null;

  function rowEditable(r: ShapedRun): boolean[] {
    return r.glyphs.map((g) => !!ids[g.id] && !!outlineOf(ids[g.id]));
  }

  function localX(event: PointerEvent): number {
    const el = event.currentTarget as SVGSVGElement;
    return event.clientX - el.getBoundingClientRect().left;
  }

  function gapOf(row: number, event: PointerEvent): GapTarget | null {
    const r = rows[row]?.run;
    if (!r) return null;
    return gapAt(glyphPlacements(r, scale), localX(event), rowEditable(r));
  }

  function onRowMove(row: number, event: PointerEvent) {
    if (!adjust) return;
    if (gapDrag) {
      const dx = localX(event) - gapDrag.startX;
      const e = gapDragEdits(dx, scale, gapMode, rtl);
      const next: Record<string, GlyphOutline> = {};
      const l = setRightBearing(gapDrag.leftBase, (bearingsOf(gapDrag.leftBase, lookup).rsb ?? 0) + e.leftRsb, lookup);
      const rb = bearingsOf(gapDrag.rightBase, lookup);
      const r = setLeftBearing(gapDrag.rightBase, (rb.lsb ?? 0) + e.rightLsb, lookup);
      next[gapDrag.leftId] = l;
      next[gapDrag.rightId] = r;
      gapDrag.last = next;
      for (const [id, o] of Object.entries(next)) onLive(id, o);
      return;
    }
    const g = gapOf(row, event);
    const same =
      (g === null && hoverGap === null) ||
      (g !== null && hoverGap !== null && hoverGap.row === row && hoverGap.gap.left === g.left);
    if (!same) hoverGap = g ? { row, gap: g } : null;
  }

  function onRowDown(row: number, event: PointerEvent) {
    if (!adjust) return;
    const g = gapOf(row, event);
    const r = rows[row]?.run;
    if (!g || !r) return;
    const leftId = ids[r.glyphs[g.left].id];
    const rightId = ids[r.glyphs[g.right].id];
    const leftBase = outlineOf(leftId);
    const rightBase = outlineOf(rightId);
    if (!leftBase || !rightBase) return;
    event.preventDefault();
    try {
      (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    } catch {
      // nothing to capture for a synthetic pointer; the drag still works
    }
    gapDrag = { row, gap: g, startX: localX(event), leftId, rightId, leftBase, rightBase, last: {} };
  }

  function onRowUp(event: PointerEvent) {
    const d = gapDrag;
    gapDrag = null;
    try {
      const el = event.currentTarget as SVGSVGElement;
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    if (!d || Object.keys(d.last).length === 0) return;
    onSpacing(
      "preview spacing",
      { [d.leftId]: d.leftBase, ...(d.rightId !== d.leftId ? { [d.rightId]: d.rightBase } : {}) },
      d.last,
    );
  }
</script>

<div class="type-preview" data-testid="type-preview">
  <div class="preview-controls">
    <label class="preview-size">
      <span>{$t("writing.preview.size")}</span>
      <input
        type="range"
        min={MIN_SIZE}
        max={MAX_SIZE}
        value={size}
        data-testid="preview-size"
        oninput={(e) => (size = clampSize(Number(e.currentTarget.value)))}
      />
      <span class="mono" data-testid="preview-size-px">{size}px</span>
    </label>
    <div class="preview-source" role="group" aria-label={$t("writing.preview.source")}>
      {#each SOURCES as s (s)}
        <button class:active={source === s} data-source={s} onclick={() => (source = s)}>
          {$t(`writing.preview.sources.${s}`)}
        </button>
      {/each}
    </div>
    <label class="check"><input type="checkbox" bind:checked={showMetrics} /> {$t("writing.preview.metrics")}</label>
    <label class="check"><input type="checkbox" bind:checked={showBoxes} data-testid="preview-boxes" /> {$t("writing.preview.boxes")}</label>
    <label class="check"><input type="checkbox" bind:checked={wrap} /> {$t("writing.preview.wrap")}</label>
    <label class="check"><input type="checkbox" bind:checked={adjust} data-testid="preview-adjust" /> {$t("writing.preview.adjust")}</label>
    {#if adjust}
      <select bind:value={gapMode} aria-label={$t("writing.preview.adjustMode")} data-testid="preview-gap-mode">
        <option value="split">{$t("writing.preview.modeSplit")}</option>
        <option value="left">{$t("writing.preview.modeLeft")}</option>
        <option value="right">{$t("writing.preview.modeRight")}</option>
      </select>
    {/if}
  </div>

  {#if source === "custom"}
    <textarea
      class="preview-input"
      data-testid="preview-input"
      rows="2"
      placeholder={$t("writing.preview.placeholder")}
      bind:value={custom}
    ></textarea>
  {:else if source === "words"}
    <div class="preview-words">
      <input
        class="word-filter"
        type="search"
        placeholder={$t("writing.preview.filterWords")}
        bind:value={wordFilter}
      />
      <div class="word-list" data-testid="word-list">
        {#each visibleWords as w (w)}
          <button class:active={picked.includes(w)} data-word={w} onclick={() => togglePicked(w)}>{w}</button>
        {:else}
          <span class="muted">{$t("writing.preview.noWords")}</span>
        {/each}
      </div>
    </div>
  {/if}

  {#if error}<p class="error" data-testid="preview-error">{error}</p>{/if}

  <div class="preview-scroll" bind:this={host} data-testid="preview-scroll" data-key={key}>
    {#if lines.length === 0}
      <p class="muted">{$t("writing.preview.empty")}</p>
    {/if}
    {#each rows as row, ri (ri)}
      {@const m = lineMetrics(row.run, scale, ascender, descender)}
      {@const placed = glyphPlacements(row.run, scale)}
      <svg
        class="preview-line"
        class:adjusting={adjust}
        class:gap-hover={adjust && hoverGap?.row === ri}
        data-testid="preview-line"
        onpointermove={(e) => onRowMove(ri, e)}
        onpointerdown={(e) => onRowDown(ri, e)}
        onpointerup={onRowUp}
        onpointercancel={onRowUp}
        onpointerleave={() => hoverGap?.row === ri && (hoverGap = null)}
        data-glyphs={row.run.glyphs.length}
        width={Math.max(m.width, 4)}
        height={Math.max(m.height, 4)}
        viewBox="0 0 {Math.max(m.width, 4)} {Math.max(m.height, 4)}"
        style:direction={rtl ? "rtl" : "ltr"}
        aria-hidden="true"
      >
        {#if showMetrics}
          <line class="p-rail" x1="0" x2={m.width} y1={m.baseline} y2={m.baseline} />
          <line class="p-rail" x1="0" x2={m.width} y1={m.baseline - guideHeight(config, "x_height") * scale} y2={m.baseline - guideHeight(config, "x_height") * scale} />
          <line class="p-rail dashed" x1="0" x2={m.width} y1={m.baseline - ascender * scale} y2={m.baseline - ascender * scale} />
          <line class="p-rail dashed" x1="0" x2={m.width} y1={m.baseline - descender * scale} y2={m.baseline - descender * scale} />
        {/if}
        {#if adjust && hoverGap?.row === ri}
          {@const gx = placed[hoverGap.gap.left].x + placed[hoverGap.gap.left].width}
          <line class="p-gap" data-testid="preview-gap" x1={gx} x2={gx} y1="0" y2={m.height} />
        {/if}
        {#each placed as p, i (i)}
          {#if showBoxes || adjust}
            <rect
              class="p-box"
              data-box
              x={p.x - (row.run.glyphs[i]?.x_offset ?? 0) * scale}
              y="0"
              width={p.width}
              height={m.height}
            />
          {/if}
          {#if paths[p.id]}
            <path
              class="p-ink"
              d={paths[p.id]}
              transform="translate({p.x} {m.baseline + p.y}) scale({scale})"
            />
          {:else if p.id === 0}
            <rect class="p-notdef" x={p.x + p.width * 0.15} y={m.baseline - ascender * scale * 0.6} width={p.width * 0.7} height={ascender * scale * 0.6} />
          {/if}
        {/each}
      </svg>
    {/each}
  </div>
</div>
