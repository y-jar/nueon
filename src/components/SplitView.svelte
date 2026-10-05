<script lang="ts">
  import { Pane, Splitpanes } from "svelte-splitpanes";
  import type { SplitNode } from "../lib/state.svelte";
  import GroupPane from "./GroupPane.svelte";
  import SplitView from "./SplitView.svelte";

  let { node }: { node: SplitNode } = $props();

  function paneSize(sizes: number[] | undefined, count: number, i: number): number {
    const size = sizes && sizes[i];
    return size ?? 100 / count;
  }
</script>

{#if node.type === "leaf"}
  <GroupPane groupId={node.groupId} />
{:else}
  <!-- "row" lays panes out side by side; splitpanes calls that non-horizontal. -->
  <Splitpanes
    horizontal={node.direction === "column"}
    on:resized={(event) => {
      node.sizes = event.detail.map((pane) => pane.size);
    }}
  >
    {#each node.children as child, i (i)}
      <Pane size={paneSize(node.sizes, node.children.length, i)} minSize={15}>
        <SplitView node={child} />
      </Pane>
    {/each}
  </Splitpanes>
{/if}
