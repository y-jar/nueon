<script lang="ts">
  import { onMount } from "svelte";
  import { ui, init } from "./lib/state.svelte";
  import Onboarding from "./components/Onboarding.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Editor from "./components/Editor.svelte";
  import Inspector from "./components/Inspector.svelte";

  onMount(() => {
    init();
  });
</script>

{#if ui.root}
  <div class="shell">
    <header class="topbar">
      <span class="brand">langloom</span>
      <span class="muted">{ui.status}</span>
    </header>
    <Sidebar />
    <main class="center">
      <Editor />
    </main>
    <Inspector />
  </div>
{:else}
  <Onboarding />
{/if}
