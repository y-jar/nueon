<script lang="ts">
  import Editor from "./Editor.svelte";
  import Grid from "./Grid.svelte";
  import Translation from "./Translation.svelte";
  import PhonologyView from "./PhonologyView.svelte";
  import FileViewer from "./FileViewer.svelte";
  import EmptyState from "./EmptyState.svelte";
  import { reloadGroupTable, type TabGroup } from "../lib/state.svelte";

  interface Props {
    group: TabGroup;
    groupId: string;
  }

  let { group, groupId }: Props = $props();
</script>

{#if group.tabs.length === 0}
  <EmptyState />
{:else if group.doc.view === "notes"}
  {#key group.id + (group.doc.selected ?? "")}
    <Editor doc={group.doc} />
  {/key}
{:else if group.doc.view === "dictionary"}
  {#key group.id + (group.doc.currentTable ?? "")}
    <Grid doc={group.doc} onRefresh={() => reloadGroupTable(groupId)} />
  {/key}
{:else if group.doc.view === "phonology"}
  <PhonologyView />
{:else if group.doc.view === "file"}
  {#key group.id + (group.doc.selected ?? "")}
    <FileViewer doc={group.doc} />
  {/key}
{:else}
  <Translation />
{/if}
