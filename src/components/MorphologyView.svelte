<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import { morphology as store } from "../lib/morphology.svelte";
  import ComposeBuilder from "./translation/ComposeBuilder.svelte";
  import FeatureBar from "./translation/FeatureBar.svelte";
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

  // Recompute the preview whenever the word, selections, picked morphemes or
  // the paradigms change.
  $effect(() => {
    void store.selectedWord;
    void store.selections;
    void store.manual;
    void store.morphology;
    void store.refreshInflection();
  });

  const word = $derived(
    store.lexicon.find((entry) => entry.id === store.selectedWord) ?? null,
  );

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
    <div class="mode-switch" role="group">
      <button
        class:active={store.tab === "compose"}
        onclick={() => (store.tab = "compose")}>
        {$t("morphology.compose")}
      </button>
      <button
        class:active={store.tab === "inflect"}
        onclick={() => (store.tab = "inflect")}>
        {$t("morphology.inflect")}
      </button>
      <button
        class:active={store.tab === "paradigms"}
        onclick={() => (store.tab = "paradigms")}>
        {$t("morphology.paradigms")}
      </button>
    </div>
    <span class="grow"></span>
    {#if store.tab === "paradigms"}
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
    {/if}
  </div>

  {#if store.error}<p class="error">{store.error}</p>{/if}

  {#if store.tab === "compose"}
    <ComposeBuilder />
  {:else if store.tab === "inflect"}
    {#if !word}
      <p class="muted">{$t("morphology.pickWord")}</p>
    {:else}
      <section class="morph-section">
        <div class="section-title">
          {word.wordname}
          {#if word.class}<span class="badge">{word.class}</span>{/if}
          <span class="muted">— {word.gloss}</span>
        </div>
        <FeatureBar
          features={store.morphology.features}
          selections={store.selections}
          onToggle={(feature, value) => store.toggleFeature(feature, value)}
        />
        {#if store.morphemes.length}
          <p class="muted small">{$t("morphology.pickHint")}</p>
        {/if}
      </section>

      {#if store.inflection}
        <section class="morph-section">
          <div class="inflect-surface">{store.inflection.surface}</div>
          <div class="inflect-pieces">
            {#each store.inflection.morphemes as morpheme, index (index)}
              <span class="piece {morpheme.kind}">
                <span class="mono">{morpheme.surface}</span>
                <span class="muted">{morpheme.gloss}</span>
              </span>
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  {:else}
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
  {/if}
</div>
