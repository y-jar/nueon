<!-- Editor status bar: live status, node count and canvas buttons. -->
<script lang="ts">
  import { editor } from "../lib/writingEditor.svelte";
  import { outlineBounds } from "../lib/writing";

  const nodeCount = $derived(
    editor.outline
      ? editor.outline.elements.reduce(
          (total, element) =>
            total + (element.kind === "contour" ? element.nodes.length : 0),
          0,
        )
      : 0,
  );
  const bounds = $derived(editor.outline ? outlineBounds(editor.outline) : null);
</script>

<div class="editor-statusbar">
  <span class="status grow">{editor.status || "Ready"}</span>
  <span class="muted">{nodeCount} nodes</span>
  {#if bounds}
    <span class="muted">
      {Math.round(bounds.max_x - bounds.min_x)} &times; {Math.round(bounds.max_y - bounds.min_y)}
    </span>
  {/if}
  <span class="muted">snap {editor.snap ? "on" : "off"}</span>
</div>
