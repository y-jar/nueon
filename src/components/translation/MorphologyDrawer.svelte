<!-- Drawer of morphemes for slot filling. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { Plus, X } from "@lucide/svelte";
  import type { AffixKind, AffixRule } from "../../lib/api";

  interface Props {
    open: boolean;
    affixes: AffixRule[];
    onAdd: (rule: AffixRule) => void;
    onRemove: (index: number) => void;
  }

  let { open, affixes, onAdd, onRemove }: Props = $props();

  let kind = $state("suffix");
  let english = $state("");
  let conlang = $state("");

  function add() {
    const e = english.trim();
    const c = conlang.trim();
    if (!e || !c) return;
    onAdd({ kind: kind as AffixKind, english: e, conlang: c });
    english = "";
    conlang = "";
  }
</script>

<div class="morph-drawer" class:open>
  <div class="drawer-inner">
    {#if affixes.length}
      {#each affixes as rule, index (index)}
        <div class="row">
          <span class="muted">{rule.kind}</span>
          <span class="mono">{rule.english} → {rule.conlang}</span>
          <span class="grow"></span>
          <button onclick={() => onRemove(index)}><X size={13} /></button>
        </div>
      {/each}
    {:else}
      <p class="muted">{$t("translation.noAffixes")}</p>
    {/if}

    <div class="row">
      <select bind:value={kind}>
        <option value="suffix">{$t("translation.suffix")}</option>
        <option value="prefix">{$t("translation.prefix")}</option>
      </select>
      <input
        placeholder={$t("translation.englishAffix")}
        bind:value={english}
      />
      <input
        placeholder={$t("translation.conlangAffix")}
        bind:value={conlang}
      />
      <button onclick={add}><Plus size={14} /> {$t("translation.add")}</button>
    </div>
  </div>
</div>
