<!-- Editor info bar: cursor, drag distance and angle, zoom, tool, layer, counts and status. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { editor, effectiveTool } from "../lib/writingEditor.svelte";
  import { outlineBounds, TOOLS } from "../lib/writing";
  import { infoReadout } from "../lib/writingInfo";

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
  const toolLabel = $derived(TOOLS.find((t) => t.id === effectiveTool())?.label ?? "");
  const info = $derived(
    infoReadout({
      cursor: editor.cursor,
      from: editor.gestureFrom,
      scale: editor.view.scale,
      tool: toolLabel,
      layer: "Fore",
    }),
  );
</script>

<div class="editor-statusbar" data-testid="info-bar">
  <span class="status grow">{editor.status || "Ready"}</span>
  <span class="info-cell mono" data-info="cursor" title={$t("writing.info.cursor")}>{info.cursor}</span>
  {#if info.measure}
    <span class="info-cell mono" data-info="measure" title={$t("writing.info.measure")}>{info.measure}</span>
  {/if}
  <span class="info-cell mono" data-info="zoom" title={$t("writing.info.zoom")}>{info.zoom}</span>
  <span class="info-cell" data-info="tool" title={$t("writing.info.tool")}>{info.tool}</span>
  <span class="info-cell" data-info="layer" title={$t("writing.info.layer")}>{info.layer}</span>
  <span class="muted" title={$t("writing.info.nodes")}>{nodeCount} nodes</span>
  {#if bounds}
    <span class="muted">
      <span title={$t("writing.info.bounds")}>
        {Math.round(bounds.max_x - bounds.min_x)} &times; {Math.round(bounds.max_y - bounds.min_y)}
      </span>
    </span>
  {/if}
  <span class="muted" title={$t("writing.info.snap")}>snap {editor.snap ? "on" : "off"}</span>
</div>
