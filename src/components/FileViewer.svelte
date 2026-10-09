<script lang="ts">
  import { t } from "svelte-i18n";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { ExternalLink, FileWarning, FolderOpen } from "@lucide/svelte";
  import * as api from "../lib/api";
  import { ui, type DocState } from "../lib/state.svelte";
  import { fileCategory } from "../lib/explorer";
  import { openInDefaultApp, revealInFileExplorer } from "../lib/fileActions";

  let { doc }: { doc: DocState } = $props();

  const name = $derived(doc.selected?.split("/").pop() ?? "");
  const category = $derived(fileCategory(name));
  const absPath = $derived(ui.root ? `${ui.root}/notes/${doc.selected}` : "");
  const url = $derived(absPath ? convertFileSrc(absPath) : "");

  let text = $state("");
  let textError = $state("");

  // Text files are shown inline; binary files use the asset protocol.
  $effect(() => {
    const path = doc.selected;
    text = "";
    textError = "";
    if (category !== "text" || !path) return;
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await api.readNote(path);
        if (!cancelled) text = snapshot.content;
      } catch (e) {
        if (!cancelled) textError = String(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

<div class="file-viewer">
  <div class="file-head">
    <span class="pane-title">{name}</span>
    <span class="grow"></span>
    <button title={$t("file.open")} onclick={() => openInDefaultApp(absPath)}>
      <ExternalLink size={14} /> {$t("file.open")}
    </button>
    <button title={$t("file.reveal")} onclick={() => revealInFileExplorer(absPath)}>
      <FolderOpen size={14} />
    </button>
  </div>

  <div class="file-body">
    {#if category === "image"}
      <img class="file-image" src={url} alt={name} />
    {:else if category === "video"}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video class="file-media" src={url} controls></video>
    {:else if category === "audio"}
      <audio class="file-audio" src={url} controls></audio>
    {:else if category === "text"}
      {#if textError}
        <p class="error">{textError}</p>
      {:else}
        <pre class="file-text">{text}</pre>
      {/if}
    {:else}
      <div class="file-unsupported">
        <FileWarning size={28} />
        <p class="muted">
          {$t("file.noPreview", { values: { name } })}
        </p>
        <button onclick={() => openInDefaultApp(absPath)}>{$t("file.open")}</button>
      </div>
    {/if}
  </div>
</div>
