<!-- Toolbox: the drawing tools. -->
<script lang="ts">
  import { editor, setTool } from "../lib/writingEditor.svelte";
  import { TOOLS } from "../lib/writing";
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
</div>
