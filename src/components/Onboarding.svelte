<!-- First-run workspace picker/onboarding. -->
<script lang="ts">
  import { autofocus } from "../lib/actions";
  import { t } from "svelte-i18n";
    import { ui, openWorkspace, openWorkspaceDialog, createWorkspaceDialog } from "../lib/state.svelte";
  import logo from "../../assets/branding/nueon-logo-bright.svg";

  let name = $state("");
  let destination = $state("");
  let path = $state("");
  let error = $state("");

  // Folder choices happen in Rust-run dialogs; JavaScript never sees a path
  // it could pass back (see docs/DECISIONS.md).
  async function browse(field: "destination" | "path") {
    try {
      if (field === "destination") await doCreateDialog();
      else await doOpenDialog();
    } catch (e) {
      error = String(e);
    }
  }

  async function openExisting(target: string) {
    error = "";
    try {
      await openWorkspace(target);
    } catch (e) {
      error = String(e);
    }
  }

  async function doCreate() {
    error = "";
    if (!name.trim()) {
      error = $t("onboarding.nameAndDestinationRequired");
      return;
    }
    await doCreateDialog();
  }

  async function doCreateDialog() {
    if (!name.trim()) {
      error = $t("onboarding.nameAndDestinationRequired");
      return;
    }
    error = "";
    try {
      await createWorkspaceDialog(name.trim());
    } catch (e) {
      if (String(e).includes("cancelled")) return;
      error = String(e);
    }
  }

  async function doOpen() {
    error = "";
    await doOpenDialog();
  }

  async function doOpenDialog() {
    error = "";
    try {
      await openWorkspaceDialog();
    } catch (e) {
      if (String(e).includes("cancelled")) return;
      error = String(e);
    }
  }
</script>

<div class="onboarding">
  {#if ui.root}
    <button class="back" onclick={() => (ui.showWorkspacePicker = false)}>
      {$t("onboarding.cancel")}
    </button>
  {/if}
  <img class="onboarding-logo" src={logo} alt={$t("app.brand")} width="64" height="64" />
  <h1>{$t("app.brand")}</h1>
  <p class="muted">{$t("onboarding.tagline")}</p>

  {#if ui.workspaces.length}
    <section>
      <h2>{$t("onboarding.openWorkspace")}</h2>
      <ul class="ws-open">
        {#each ui.workspaces as ws (ws.path)}
          <li>
            <button onclick={() => openExisting(ws.path)}
              >{ws.name || ws.path}</button
            >
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="cols">
    <section>
      <h2>{$t("onboarding.createNew")}</h2>
      <input
        use:autofocus
        placeholder={$t("onboarding.namePlaceholder")}
        bind:value={name}
      />
      <div class="row">
        <input
          placeholder={$t("onboarding.destinationPlaceholder")}
          bind:value={destination}
        />
        <button onclick={() => browse("destination")}
          >{$t("onboarding.browse")}</button
        >
      </div>
      <button onclick={doCreate}>{$t("onboarding.create")}</button>
    </section>

    <section>
      <h2>{$t("onboarding.openExisting")}</h2>
      <div class="row">
        <input
          placeholder={$t("onboarding.pathPlaceholder")}
          bind:value={path}
        />
        <button onclick={() => browse("path")}>{$t("onboarding.browse")}</button>
      </div>
      <button onclick={doOpen}>{$t("onboarding.open")}</button>
    </section>
  </div>

  {#if error}<p class="error">{error}</p>{/if}
</div>
