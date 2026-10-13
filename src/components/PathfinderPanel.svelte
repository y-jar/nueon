<!-- Pathfinder panel: boolean operations (stubbed). -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { PathOperation } from "../lib/api";
  import { runPathfinder } from "../lib/writingEditor.svelte";

  const OPS: { id: PathOperation; label: string }[] = [
    { id: "union", label: "writing.pathfinderUnion" },
    { id: "difference", label: "writing.pathfinderDifference" },
    { id: "intersect", label: "writing.pathfinderIntersect" },
    { id: "exclude", label: "writing.pathfinderExclude" },
  ];
</script>

<div class="pathfinder-panel">
  <h2>{$t("writing.pathfinder")}</h2>
  {#each OPS as op (op.id)}
    <button onclick={() => void runPathfinder(op.id)}>{$t(op.label)}</button>
  {/each}
</div>
