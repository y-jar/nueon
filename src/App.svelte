<script lang="ts">
  import { onMount } from "svelte";
  import { workspaceList, type WorkspaceEntry } from "./lib/api";

  let workspaces = $state<WorkspaceEntry[]>([]);
  let status = $state("connecting…");

  onMount(async () => {
    try {
      workspaces = await workspaceList();
      status = workspaces.length
        ? `${workspaces.length} workspace(s) registered`
        : "no workspaces registered";
    } catch (error) {
      status = `backend error: ${String(error)}`;
    }
  });
</script>

<div class="shell">
  <header class="topbar">
    <span class="brand">langloom</span>
  </header>

  <aside class="sidebar">
    <div class="pane-title">Notes</div>
    <div class="pane-title">Tables</div>
    <div class="pane-title">Presets</div>
    <div class="grow"></div>
    <div class="switcher">
      <div class="pane-title">Workspace</div>
      <div class="muted">{status}</div>
      {#if workspaces.length}
        <ul class="ws-list">
          {#each workspaces as ws (ws.path)}
            <li>{ws.name || ws.path}</li>
          {/each}
        </ul>
      {/if}
    </div>
  </aside>

  <main class="center">
    <div class="placeholder">
      Tauri shell online — CodeMirror editor, dictionary grid, and translation
      builder arrive in stages R3–R5.
    </div>
  </main>

  <aside class="inspector">
    <div class="pane-title">Inspector</div>
  </aside>
</div>
