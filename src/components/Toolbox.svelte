<!-- Toolbox: the drawing tools and the options of the active tool. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    Brush,
    CircleDot,
    Eraser,
    FlipHorizontal2,
    Hand,
    MousePointer,
    MousePointer2,
    PenTool,
    Shapes,
    ZoomIn,
  } from "@lucide/svelte";
  import { editor, setNib, setShape, setTool } from "../lib/writingEditor.svelte";
  import { TOOLS, TOOL_GROUPS, type ToolId } from "../lib/writing";
  import type { ShapeKind } from "../lib/writingCommands";

  const ICONS = {
    MousePointer2,
    MousePointer,
    Hand,
    ZoomIn,
    PenTool,
    CircleDot,
    Brush,
    Shapes,
    FlipHorizontal2,
    Eraser,
  } as const;

  const byId = new Map(TOOLS.map((tool) => [tool.id, tool]));
  const groups = TOOL_GROUPS.map((group) => ({
    id: group.id,
    tools: group.tools.map((id: ToolId) => byId.get(id)!),
  }));

  const SHAPES: { id: ShapeKind; label: string }[] = [
    { id: "rect", label: "Rectangle" },
    { id: "ellipse", label: "Ellipse" },
    { id: "polygon", label: "Polygon" },
    { id: "star", label: "Star" },
    { id: "line", label: "Line" },
  ];
</script>

<div class="toolbox" role="toolbar" aria-label={$t("writing.toolbox")}>
  {#each groups as group, gi (group.id)}
    {#if gi > 0}<div class="tool-sep" role="separator"></div>{/if}
    <div class="tool-group" data-group={group.id}>
      {#each group.tools as tool (tool.id)}
        {@const Icon = ICONS[tool.icon as keyof typeof ICONS]}
        <button
          class="tool"
          class:active={editor.activeTool === tool.id}
          data-tool={tool.id}
          title={tool.tooltip}
          aria-label={tool.label}
          aria-pressed={editor.activeTool === tool.id}
          onclick={() => setTool(tool.id)}
        >
          <Icon size={15} />
          <span class="tool-label">{tool.label}</span>
          <span class="tool-shortcut">{tool.shortcut}</span>
        </button>
      {/each}
    </div>
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
