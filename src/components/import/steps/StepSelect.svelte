<!-- Import step: pick file and format. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { open } from "@tauri-apps/plugin-dialog";
  import { FileUp, RefreshCw, FileSpreadsheet } from "@lucide/svelte";
  import * as api from "../../../lib/api";

  interface Props {
    options: api.ImportOptions;
    path: string;
    busy: boolean;
    onDetected: (path: string, detection: api.Detection) => void;
    onBusy: (busy: boolean) => void;
  }

  let {
    options = $bindable(),
    path = $bindable(),
    busy,
    onDetected,
    onBusy,
  }: Props = $props();

  let error = $state("");

  const DELIMITERS = [
    { value: "\t", label: "Tab" },
    { value: ",", label: "Comma" },
    { value: ";", label: "Semicolon" },
    { value: "|", label: "Pipe" },
  ];

  function defaultTableName(p: string): string {
    const base = p.split(/[\\/]/).pop() ?? "imported";
    return base.replace(/\.[^.]+$/, "");
  }

  async function pick() {
    error = "";
    const selected = await open({
      multiple: false,
      filters: [
        { name: $t("import.fileFilter"), extensions: ["csv", "tsv", "txt", "tab"] },
      ],
    });
    if (typeof selected !== "string") return;
    path = selected;
    if (!options.target_table) options.target_table = defaultTableName(selected);
    await rescan();
  }

  async function rescan() {
    if (!path) return;
    onBusy(true);
    try {
      const detection = await api.importDetect(path, options);
      onDetected(path, detection);
      error = "";
    } catch (e) {
      error = String(e);
    } finally {
      onBusy(false);
    }
  }
</script>

<div class="import-step">
  <p class="muted">{$t("import.selectHint")}</p>

  <button class="import-dropzone" onclick={pick} disabled={busy}>
    {#if path}
      <FileSpreadsheet size={26} />
      <span class="import-file">{path.split(/[\\/]/).pop()}</span>
      <span class="muted import-path">{path}</span>
    {:else}
      <FileUp size={26} />
      <span>{$t("import.chooseFile")}</span>
      <span class="muted">.csv .tsv .txt</span>
    {/if}
  </button>

  <div class="import-grid">
    <label class="import-field">
      <span>{$t("import.delimiter")}</span>
      <select bind:value={options.delimiter}>
        {#each DELIMITERS as d (d.value)}
          <option value={d.value}>{d.label}</option>
        {/each}
      </select>
    </label>

    <label class="import-field">
      <span>{$t("import.quote")}</span>
      <input maxlength="1" bind:value={options.quote} />
    </label>

    <label class="import-field">
      <span>{$t("import.tagDelimiter")}</span>
      <input maxlength="1" bind:value={options.tag_list_delimiter} />
    </label>

    <label class="import-field">
      <span>{$t("import.tagPrefix")}</span>
      <input maxlength="3" bind:value={options.tag_prefix} />
    </label>
  </div>

  <div class="import-checks">
    <label>
      <input type="checkbox" bind:checked={options.has_header} />
      {$t("import.hasHeader")}
    </label>
    <label>
      <input type="checkbox" bind:checked={options.skip_placeholders} />
      {$t("import.skipPlaceholders")}
    </label>
  </div>

  <button class="import-rescan" onclick={rescan} disabled={!path || busy}>
    <RefreshCw size={13} /> {$t("import.rescan")}
  </button>

  {#if error}<p class="error">{error}</p>{/if}
</div>
