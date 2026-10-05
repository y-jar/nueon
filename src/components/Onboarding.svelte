<script lang="ts">
  import { autofocus } from "../lib/actions";
  import { t } from "svelte-i18n";
  import { open } from "@tauri-apps/plugin-dialog";
  import { ui, openWorkspace, createWorkspace } from "../lib/state.svelte";

  let name = $state("");
  let destination = $state("");
  let path = $state("");
  let error = $state("");

  async function browse(field: "destination" | "path") {
    const selected = await open({
      directory: true,
      multiple: false,
      title: $t("onboarding.chooseFolder"),
    });
    if (typeof selected === "string") {
      if (field === "destination") destination = selected;
      else path = selected;
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
    if (!name.trim() || !destination.trim()) {
      error = $t("onboarding.nameAndDestinationRequired");
      return;
    }
    try {
      await createWorkspace(name.trim(), destination.trim());
    } catch (e) {
      error = String(e);
    }
  }

  async function doOpen() {
    error = "";
    if (!path.trim()) {
      error = $t("onboarding.pathRequired");
      return;
    }
    try {
      await openWorkspace(path.trim());
    } catch (e) {
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
