<script lang="ts">
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
      title: "Choose folder",
    });
    if (typeof selected === "string") {
      if (field === "destination") destination = selected;
      else path = selected;
    }
  }

  async function doCreate() {
    error = "";
    if (!name.trim() || !destination.trim()) {
      error = "name and destination are required";
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
      error = "path is required";
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
  <h1>langloom</h1>
  <p class="muted">A conlang editor and creation app.</p>

  {#if ui.workspaces.length}
    <section>
      <h2>Open a workspace</h2>
      <ul class="ws-open">
        {#each ui.workspaces as ws (ws.path)}
          <li>
            <button onclick={() => openWorkspace(ws.path)}
              >{ws.name || ws.path}</button
            >
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="cols">
    <section>
      <h2>Create new</h2>
      <input placeholder="name" bind:value={name} />
      <div class="row">
        <input placeholder="destination folder" bind:value={destination} />
        <button onclick={() => browse("destination")}>Browse…</button>
      </div>
      <button onclick={doCreate}>Create</button>
    </section>

    <section>
      <h2>Open existing</h2>
      <div class="row">
        <input placeholder="folder path" bind:value={path} />
        <button onclick={() => browse("path")}>Browse…</button>
      </div>
      <button onclick={doOpen}>Open</button>
    </section>
  </div>

  {#if error}<p class="error">{error}</p>{/if}
</div>
