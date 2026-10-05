<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    FileText,
    Table2,
    Languages,
    GitBranch,
    Settings,
    FolderOpen,
  } from "@lucide/svelte";
  import {
    ui,
    setActivity,
    openSettings,
    openWorkspace,
  } from "../lib/state.svelte";

  let wsMenu = $state(false);

  const items = [
    { id: "notes", icon: FileText, label: "activity.notes" },
    { id: "dictionary", icon: Table2, label: "activity.dictionary" },
    { id: "translation", icon: Languages, label: "activity.translation" },
    { id: "git", icon: GitBranch, label: "activity.git" },
  ] as const;
</script>

<nav class="activitybar">
  <div class="brand" title={$t("app.brand")}>L</div>

  {#each items as item (item.id)}
    <button
      class="activity"
      class:active={ui.activity === item.id}
      title={$t(item.label)}
      onclick={() => setActivity(item.id)}
    >
      <item.icon size={20} />
    </button>
  {/each}

  <div class="grow"></div>

  <button
    class="activity"
    class:active={wsMenu}
    title={$t("sidebar.workspace")}
    onclick={() => (wsMenu = !wsMenu)}
  >
    <FolderOpen size={20} />
  </button>

  <button
    class="activity"
    title={$t("activity.settings")}
    onclick={openSettings}
  >
    <Settings size={20} />
  </button>

  {#if wsMenu}
    <div class="ws-flyout">
      {#each ui.workspaces as ws (ws.path)}
        <button
          onclick={() => {
            wsMenu = false;
            openWorkspace(ws.path);
          }}>{ws.name || ws.path}</button
        >
      {/each}
      {#if !ui.workspaces.length}
        <p class="muted">{$t("sidebar.openWorkspace")}</p>
      {/if}
    </div>
  {/if}
</nav>
