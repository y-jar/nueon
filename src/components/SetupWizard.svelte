<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import { ui, openSetupWizard, closeSetupWizard } from "../lib/state.svelte";

  const STEPS = [
    "setup.stepLanguage",
    "setup.stepPhonology",
    "setup.stepGrammar",
    "setup.stepMorphology",
  ];

  const ORDERS = ["SVO", "SOV", "VSO"] as const;
  const STARTER_CONSONANTS = "p t k m n s l";
  const STARTER_VOWELS = "a i u";

  let step = $state(0);
  let busy = $state(false);
  let error = $state("");

  let name = $state("");
  let author = $state("");
  let script = $state("");
  let direction = $state<api.TextDirection>("ltr");

  let consonants = $state(STARTER_CONSONANTS);
  let vowels = $state(STARTER_VOWELS);

  let order = $state<(typeof ORDERS)[number]>("SVO");

  let addParadigm = $state(true);
  let pluralEnding = $state("i");

  async function load() {
    try {
      const [language, grammar, phonology, dismissed] = await Promise.all([
        api.languageGet(),
        api.grammarGet(),
        api.phonologyGet(),
        api.warningDismissed("setup-wizard"),
      ]);
      name = language.name;
      author = language.author;
      script = language.script;
      direction = language.direction;
      // A brand-new workspace opens the checklist; a populated one does not
      // (the user can still run it from Settings).
      const blank =
        language.name.trim() === "" &&
        grammar.rules.length === 0 &&
        phonology.phonemes.length === 0;
      if (blank && !dismissed) openSetupWizard();
    } catch {
      // A failed probe just leaves the wizard closed.
    }
  }

  onMount(load);

  // Refresh the prefilled values whenever the wizard is reopened.
  let wasOpen = false;
  $effect(() => {
    if (ui.setupWizardOpen && !wasOpen) void load();
    wasOpen = ui.setupWizardOpen;
  });

  function parseSymbols(text: string): string[] {
    return [
      ...new Set(
        text
          .split(/[\s,]+/)
          .map((symbol) => symbol.trim())
          .filter(Boolean),
      ),
    ];
  }

  function slotsFor(wordOrder: string): api.ClauseSlot[] {
    const noun: api.ClauseSlot = { kind: "pos", class: "noun" };
    const verb: api.ClauseSlot = { kind: "pos", class: "verb" };
    switch (wordOrder) {
      case "SOV":
        return [noun, noun, verb];
      case "VSO":
        return [verb, noun, noun];
      default:
        return [noun, verb, noun];
    }
  }

  async function finish() {
    if (busy) return;
    busy = true;
    try {
      await api.languageSet({
        name: name.trim(),
        author: author.trim(),
        description: "",
        script: script.trim(),
        direction,
      });

      const phonemes: api.Phoneme[] = [
        ...parseSymbols(consonants).map((symbol) => ({
          symbol,
          kind: "consonant" as const,
        })),
        ...parseSymbols(vowels).map((symbol) => ({
          symbol,
          kind: "vowel" as const,
        })),
      ];
      await api.phonologySet({ phonemes, syllables: [] });

      const grammar = await api.grammarGet();
      const rule: api.GrammarRule = {
        name: order,
        description: `${order} word order`,
        slots: slotsFor(order),
      };
      await api.grammarSet({
        rules: [...grammar.rules.filter((r) => r.name !== order), rule],
      });

      const translation = await api.translationConfig();
      await api.configSet("translation", { ...translation, default_rule: order });

      if (addParadigm && pluralEnding.trim()) {
        const morphology = await api.translationMorphology();
        await api.setTranslationMorphology({
          features: morphology.features,
          paradigms: [
            ...morphology.paradigms.filter((p) => p.class !== "noun"),
            {
              class: "noun",
              rows: [
                {
                  when: { number: "plural" },
                  surface: pluralEnding.trim(),
                  kind: "suffix",
                },
              ],
            },
          ],
        });
      }

      await api.dismissWarning("setup-wizard").catch(() => {});
      closeSetupWizard();
      error = "";
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if ui.setupWizardOpen}
  <div class="modal-overlay" role="presentation">
    <div class="modal setup-wizard" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-head">
        <span class="pane-title">{$t("setup.title")}</span>
      </div>
      <div class="modal-body">
        <ol class="setup-steps">
          {#each STEPS as label, index (label)}
            <li class:active={index === step} class:done={index < step}>
              {index + 1}. {$t(label)}
            </li>
          {/each}
        </ol>

        {#if step === 0}
          <p class="muted">{$t("setup.languageHint")}</p>
          <label class="field"
            >{$t("settings.name")}
            <input bind:value={name} />
          </label>
          <label class="field"
            >{$t("settings.author")}
            <input bind:value={author} />
          </label>
          <label class="field"
            >{$t("settings.script")}
            <input bind:value={script} />
          </label>
          <label class="field"
            >{$t("settings.direction")}
            <select bind:value={direction}>
              <option value="ltr">{$t("settings.ltr")}</option>
              <option value="rtl">{$t("settings.rtl")}</option>
            </select>
          </label>
        {:else if step === 1}
          <p class="muted">{$t("setup.phonologyHint")}</p>
          <label class="field"
            >{$t("setup.consonants")}
            <input bind:value={consonants} />
          </label>
          <label class="field"
            >{$t("setup.vowels")}
            <input bind:value={vowels} />
          </label>
        {:else if step === 2}
          <p class="muted">{$t("setup.grammarHint")}</p>
          <label class="field"
            >{$t("setup.wordOrder")}
            <select bind:value={order}>
              {#each ORDERS as value (value)}
                <option value={value}>{value}</option>
              {/each}
            </select>
          </label>
        {:else}
          <p class="muted">{$t("setup.morphologyHint")}</p>
          <label class="field"
            >{$t("setup.pluralEnding")}
            <input bind:value={pluralEnding} disabled={!addParadigm} />
          </label>
          <label class="muted row">
            <input type="checkbox" bind:checked={addParadigm} />
            {$t("setup.addParadigm")}
          </label>
        {/if}

        {#if error}<p class="error">{error}</p>{/if}

        <div class="row setup-actions">
          <button
            class="muted"
            onclick={() => api.dismissWarning("setup-wizard").then(closeSetupWizard)}
            >{$t("setup.skip")}</button
          >
          <span class="grow"></span>
          {#if step > 0}
            <button onclick={() => (step -= 1)}>{$t("setup.back")}</button>
          {/if}
          {#if step < STEPS.length - 1}
            <button class="primary" onclick={() => (step += 1)}
              >{$t("setup.next")}</button
            >
          {:else}
            <button class="primary" disabled={busy} onclick={finish}
              >{$t("setup.finish")}</button
            >
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}
