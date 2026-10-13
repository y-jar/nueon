<!-- Canvas with typographic guides and the (stubbed) pointer surface. -->
<script lang="ts">
  import type { WritingConfig } from "../lib/api";
  import { editor, handleCanvasPointer } from "../lib/writingEditor.svelte";
  import { guideLines, outlinePathData, flipY } from "../lib/writing";

  interface Props {
    config: WritingConfig;
  }

  let { config }: Props = $props();

  const guides = $derived(guideLines(config));
  const minX = -100;
  const maxX = $derived((config.upem || 1000) + 200);
  const storageMinY = $derived(Math.min(config.descender || -200, -200) - 100);
  const storageMaxY = $derived(Math.max(config.ascender || 800, 800) + 100);

  const viewBox = $derived(
    `${minX} ${-storageMaxY} ${(maxX - minX) / editor.zoom} ${(storageMaxY - storageMinY) / editor.zoom}`,
  );
  const d = $derived(editor.outline ? outlinePathData(editor.outline, true) : "");
</script>

<div class="glyph-canvas">
  <svg
    class="canvas-svg"
    role="application"
    aria-label="Glyph canvas"
    {viewBox}
    preserveAspectRatio="xMidYMid meet"
    onpointerdown={() => handleCanvasPointer(editor.activeTool)}
  >
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
    {#if d}<path class="outline" d={d} />{/if}
  </svg>
</div>
