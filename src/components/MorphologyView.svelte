<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import { morphology as store } from "../lib/morphology.svelte";
  import FeatureEditor from "./translation/FeatureEditor.svelte";
  import ParadigmEditor from "./translation/ParadigmEditor.svelte";
  import MorphologyDrawer from "./translation/MorphologyDrawer.svelte";

  onMount(() => void store.load());

  // The english → conlang affix rules live in the translation options.
  let affixes = $state<api.AffixRule[]>([]);
  let rulesError = $state("");

  onMount(async () => {
    try {
      affixes = (await api.translationOptions()).affixes;
    } catch (e) {
      rulesError = String(e);
    }
  });

  async function persistRules() {
    try {
      const options = await api.translationOptions();
      await api.setTranslationOptions({ ...options, affixes });
      rulesError = "";
    } catch (e) {
      rulesError = String(e);
    }
  }

  function addAffix(rule: api.AffixRule) {
    affixes = [...affixes, rule];
    void persistRules();
  }

  function removeAffix(index: number) {
    affixes = affixes.filter((_, i) => i !== index);
    void persistRules();
  }

  const onMorphology = (next: api.Morphology) => void store.save(next);
</script>

<div class="morphology-view">
  <div class="morph-toolbar">
    <span class="pane-title">{$t("morphology.title")}</span>
    <span class="grow"></span>
    <label class="morph-class-picker">
      {$t("morphology.class")}
      <select
        value={store.selectedClass}
        onchange={(e) => (store.selectedClass = e.currentTarget.value)}
      >
        {#each store.classNames() as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if store.error}<p class="error">{store.error}</p>{/if}

  <section class="morph-section">
    <div class="section-title">{$t("morphology.features")}</div>
    <FeatureEditor morphology={store.morphology} onChange={onMorphology} />
  </section>

  <section class="morph-section">
    <div class="section-title">{$t("morphology.rules")}</div>
    <p class="muted">{$t("morphology.rulesHint")}</p>
    {#if rulesError}<p class="error">{rulesError}</p>{/if}
    <MorphologyDrawer open={true} {affixes} onAdd={addAffix} onRemove={removeAffix} />
  </section>

  <section class="morph-section">
    <div class="section-title">
      {$t("morphology.endings")} — <span class="badge tag">{store.selectedClass}</span>
    </div>
    <ParadigmEditor
      morphology={store.morphology}
      classId={store.selectedClass}
      morphemes={store.morphemes}
      onChange={onMorphology}
    />
  </section>
</div>
