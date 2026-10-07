<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    Save,
    Trash2,
    Check,
    X,
    Download,
    Upload,
    Braces,
  } from "@lucide/svelte";
  import type { SyntaxGrid, TranslationMode } from "../../lib/api";

  interface Props {
    presets: SyntaxGrid[];
    grammarRules: string[];
    draftName: string;
    hasPreset: boolean;
    showMorphology: boolean;
    mode: TranslationMode;
    onLoad: (name: string) => void;
    onLoadGrammar: (name: string) => void;
    onSave: () => void;
    onDelete: () => void;
    onExport: () => void;
    onImport: () => void;
    onToggleMorphology: () => void;
    onSetMode: (mode: TranslationMode) => void;
  }

  let {
    presets,
    grammarRules,
    draftName = $bindable(),
    hasPreset,
    showMorphology,
    mode,
    onLoad,
    onLoadGrammar,
    onSave,
    onDelete,
    onExport,
    onImport,
    onToggleMorphology,
    onSetMode,
  }: Props = $props();

  let confirming = $state(false);
</script>

<div class="translation-toolbar">
  <div class="mode-switch" role="group">
    <button
      class:active={mode === "grid"}
      title={$t("translation.modeGridHint")}
      onclick={() => onSetMode("grid")}>{$t("translation.modeGrid")}</button
    >
    <button
      class:active={mode === "direct"}
      title={$t("translation.modeDirectHint")}
      onclick={() => onSetMode("direct")}>{$t("translation.modeDirect")}</button
    >
  </div>

  {#if mode === "grid"}
    {#if grammarRules.length}
      <select
        value=""
        title={$t("translation.loadGrammarHint")}
        onchange={(e) => {
          const value = e.currentTarget.value;
          if (value) onLoadGrammar(value);
          e.currentTarget.value = "";
        }}
      >
        <option value="">{$t("translation.loadGrammar")}</option>
        {#each grammarRules as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
    {/if}
    <select
      value=""
      onchange={(e) => {
        const value = e.currentTarget.value;
        if (value) onLoad(value);
        e.currentTarget.value = "";
      }}
    >
      <option value="">{$t("translation.loadPreset")}</option>
      {#each presets as preset (preset.preset_name)}
        <option value={preset.preset_name}>{preset.preset_name}</option>
      {/each}
    </select>

    <input
      class="name-input"
      placeholder={$t("translation.presetName")}
      bind:value={draftName}
    />

    <button title={$t("translation.savePreset")} onclick={onSave}>
      <Save size={15} />
    </button>

    {#if confirming}
      <span class="confirm-group">
        <span class="muted">{$t("translation.confirmDelete")}</span>
        <button
          class="danger"
          title={$t("translation.delete")}
          onclick={() => {
            confirming = false;
            onDelete();
          }}
        >
          <Check size={14} />
        </button>
        <button title={$t("grid.cancel")} onclick={() => (confirming = false)}>
          <X size={14} />
        </button>
      </span>
    {:else if hasPreset}
      <button
        title={$t("translation.delete")}
        onclick={() => (confirming = true)}
      >
        <Trash2 size={15} />
      </button>
    {/if}
  {/if}

  <span class="grow"></span>

  <button
    class:active={showMorphology}
    title={$t("translation.morphology")}
    onclick={onToggleMorphology}
  >
    <Braces size={15} />
  </button>
  {#if mode === "grid"}
    <button title={$t("translation.exportPresets")} onclick={onExport}>
      <Upload size={15} />
    </button>
    <button title={$t("translation.importPresets")} onclick={onImport}>
      <Download size={15} />
    </button>
  {/if}
</div>
