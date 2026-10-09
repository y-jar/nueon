<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    FileText,
    Table2,
    Languages,
    AudioLines,
    GitBranch,
    Settings,
    FolderOpen,
    FolderPlus,
  } from "@lucide/svelte";
  import {
    ui,
    setActivity,
    openSettings,
    openWorkspace,
  } from "../lib/state.svelte";
  import logo from "../../assets/branding/nueon-logo-dark.svg";

  let wsMenu = $state(false);
  let wsError = $state("");

  async function switchTo(path: string) {
    wsError = "";
    try {
      await openWorkspace(path);
      wsMenu = false;
    } catch (e) {
      wsError = String(e);
    }
  }

  const items = [
    { id: "notes", icon: FileText, label: "activity.notes" },
    { id: "dictionary", icon: Table2, label: "activity.dictionary" },
    { id: "translation", icon: Languages, label: "activity.translation" },
    { id: "phonology", icon: AudioLines, label: "activity.phonology" },
    { id: "git", icon: GitBranch, label: "activity.git" },
  ] as const;
</script>

<nav class="activitybar">
  <div class="brand" title={$t("app.brand")}>
    <img src={logo} alt={$t("app.brand")} width="26" height="26" />
  </div>

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
        <button onclick={() => switchTo(ws.path)}>{ws.name || ws.path}</button>
      {/each}
      {#if wsError}<p class="error">{wsError}</p>{/if}
      <button
        class="ws-new"
        onclick={() => {
          wsMenu = false;
          ui.showWorkspacePicker = true;
        }}
      >
        <FolderPlus size={14} /> {$t("sidebar.switchOrNew")}
      </button>
    </div>
  {/if}
</nav>
