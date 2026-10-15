<!-- Toolbox: the drawing tools and the options of the active tool. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    Brush,
    CircleDot,
    Eraser,
    FlipHorizontal2,
    Hand,
    Image,
    ImagePlus,
    MousePointer,
    MousePointer2,
    PenLine,
    PenTool,
    Ruler,
    Shapes,
    ZoomIn,
  } from "@lucide/svelte";
  import { addBackImage, editor, setNib, setShape, setTool, toggleLayer } from "../lib/writingEditor.svelte";
  import type { LayerId } from "../lib/writingLayers";
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

  const LAYERS: { id: LayerId; label: string; tooltip: string; icon: typeof Ruler }[] = [
    { id: "guide", label: "Guide", tooltip: "Guide rails: metric lines and guides", icon: Ruler },
    { id: "back", label: "Back", tooltip: "Back layer: the tracing image behind the drawing", icon: Image },
    { id: "fore", label: "Fore", tooltip: "Fore layer: the outline being drawn", icon: PenLine },
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

  <div class="tool-sep" role="separator"></div>
  <div class="tool-group" data-group="layers">
    {#each LAYERS as layer (layer.id)}
      {@const LayerIcon = layer.icon}
      <button
        class="tool layer-toggle"
        class:active={editor.layers[layer.id]}
        data-layer={layer.id}
        title={layer.tooltip}
        aria-label={layer.label}
        aria-pressed={editor.layers[layer.id]}
        onclick={() => toggleLayer(layer.id)}
      >
        <LayerIcon size={15} />
        <span class="tool-label">{layer.label}</span>
      </button>
    {/each}
    <button
      class="tool"
      data-action="back-image-add"
      title="Add tracing image (png, jpg or webp) behind the drawing"
      aria-label="Add tracing image"
      onclick={() => void addBackImage()}
    >
      <ImagePlus size={15} />
    </button>
  </div>

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
