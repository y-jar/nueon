<!-- Toolbox: the drawing tools and the options of the active tool. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { editor, setNib, setShape, setTool } from "../lib/writingEditor.svelte";
  import { TOOLS } from "../lib/writing";
  import type { ShapeKind } from "../lib/writingCommands";

  const SHAPES: { id: ShapeKind; label: string }[] = [
    { id: "rect", label: "Rectangle" },
    { id: "ellipse", label: "Ellipse" },
    { id: "polygon", label: "Polygon" },
    { id: "star", label: "Star" },
    { id: "line", label: "Line" },
  ];
</script>

<div class="toolbox">
  {#each TOOLS as tool (tool.id)}
    <button
      class="tool"
      class:active={editor.activeTool === tool.id}
      title={`${tool.label} (${tool.shortcut})`}
      onclick={() => setTool(tool.id)}
    >
      <span class="tool-label">{tool.label}</span>
      <span class="tool-shortcut">{tool.shortcut}</span>
    </button>
  {/each}

  {#if editor.activeTool === "shapes"}
    <label class="tool-option">
      <span>{$t("writing.shape")}</span>
      <select
        value={editor.shape}
        onchange={(e) => setShape(e.currentTarget.value as ShapeKind)}
      >
        {#each SHAPES as shape (shape.id)}
          <option value={shape.id}>{shape.label}</option>
        {/each}
      </select>
    </label>
  {/if}

  {#if editor.activeTool === "brush"}
    <label class="tool-option">
      <span>{$t("writing.nibWidth")}</span>
      <input
        type="number"
        min="1"
        value={editor.nibWidth}
        onchange={(e) => setNib(Number(e.currentTarget.value), editor.nibAngle)}
      />
    </label>
    <label class="tool-option">
      <span>{$t("writing.nibAngle")}</span>
      <input
        type="number"
        value={editor.nibAngle}
        onchange={(e) => setNib(editor.nibWidth, Number(e.currentTarget.value))}
      />
    </label>
  {/if}
</div>
