<!-- Pathfinder panel: boolean operations over a glyph's shapes. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { PathOperation } from "../lib/api";
  import { editor, runPathfinder } from "../lib/writingEditor.svelte";
  import { canPathfind } from "../lib/writingCommands";

  const OPS: { id: PathOperation; label: string }[] = [
    { id: "union", label: "writing.pathfinderUnion" },
    { id: "difference", label: "writing.pathfinderDifference" },
    { id: "intersect", label: "writing.pathfinderIntersect" },
    { id: "exclude", label: "writing.pathfinderExclude" },
  ];

  const ready = $derived(canPathfind(editor.outline));
</script>

<div class="pathfinder-panel">
  <h2>{$t("writing.pathfinder")}</h2>
  {#each OPS as op (op.id)}
    <button disabled={!ready} onclick={() => void runPathfinder(op.id)}>
      {$t(op.label)}
    </button>
  {/each}
  {#if !ready}<p class="muted hint">{$t("writing.pathfinderNeedsTwo")}</p>{/if}
</div>
