<script lang="ts">
  import { t } from "svelte-i18n";
  import { Plus, X } from "@lucide/svelte";
  import type { AffixKind, Morphology, Paradigm } from "../../lib/api";

  interface Props {
    morphology: Morphology;
    onChange: (morphology: Morphology) => void;
  }

  let { morphology, onChange }: Props = $props();

  const CLASSES = ["verb", "noun", "adjective", "adverb", "pronoun"];

  function paradigmFor(classId: string): Paradigm {
    const found = morphology.paradigms.find(
      (paradigm) => paradigm.class === classId,
    );
    return found ?? { class: classId, rows: [] };
  }

  function update(next: Paradigm) {
    const others = morphology.paradigms.filter((p) => p.class !== next.class);
    onChange({ ...morphology, paradigms: [...others, next] });
  }

  function addRow(classId: string) {
    const paradigm = paradigmFor(classId);
    update({
      ...paradigm,
      rows: [...paradigm.rows, { when: {}, surface: "", kind: "suffix" }],
    });
  }

  function removeRow(classId: string, index: number) {
    const paradigm = paradigmFor(classId);
    update({ ...paradigm, rows: paradigm.rows.filter((_, i) => i !== index) });
  }

  function setWhen(
    classId: string,
    index: number,
    featureId: string,
    valueId: string,
  ) {
    const paradigm = paradigmFor(classId);
    const rows = paradigm.rows.map((row, i) => {
      if (i !== index) return row;
      const when = { ...row.when };
      if (valueId) when[featureId] = valueId;
      else delete when[featureId];
      return { ...row, when };
    });
    update({ ...paradigm, rows });
  }

  function setSurface(classId: string, index: number, surface: string) {
    const paradigm = paradigmFor(classId);
    update({
      ...paradigm,
      rows: paradigm.rows.map((row, i) => (i === index ? { ...row, surface } : row)),
    });
  }

  function setKind(classId: string, index: number, kind: AffixKind) {
    const paradigm = paradigmFor(classId);
    update({
      ...paradigm,
      rows: paradigm.rows.map((row, i) => (i === index ? { ...row, kind } : row)),
    });
  }
</script>

<div class="paradigm-editor">
  <p class="muted">{$t("translation.paradigmHint")}</p>
  {#each CLASSES as classId (classId)}
    {@const paradigm = paradigmFor(classId)}
    <div class="paradigm-group">
      <div class="paradigm-head">
        <span class="badge tag">{classId}</span>
        <button onclick={() => addRow(classId)}
          ><Plus size={13} /> {$t("translation.addEnding")}</button
        >
      </div>
      {#if paradigm.rows.length === 0}
        <p class="muted">{$t("translation.noEndings")}</p>
      {:else}
        {#each paradigm.rows as row, index (index)}
          <div class="paradigm-row">
            {#each morphology.features as feature (feature.id)}
              <label class="when">
                <span class="muted">{feature.label}</span>
                <select
                  value={row.when[feature.id] ?? ""}
                  onchange={(e) =>
                    setWhen(classId, index, feature.id, e.currentTarget.value)}
                >
                  <option value="">{$t("translation.any")}</option>
                  {#each feature.values as value (value.id)}
                    <option value={value.id}>{value.label}</option>
                  {/each}
                </select>
              </label>
            {/each}
            <select
              value={row.kind}
              onchange={(e) => setKind(classId, index, e.currentTarget.value as AffixKind)}
            >
              <option value="suffix">{$t("translation.suffix")}</option>
              <option value="prefix">{$t("translation.prefix")}</option>
            </select>
            <input
              class="slot-input"
              placeholder={$t("translation.ending")}
              value={row.surface}
              oninput={(e) => setSurface(classId, index, e.currentTarget.value)}
            />
            <button class="slot-remove" onclick={() => removeRow(classId, index)}>
              <X size={13} />
            </button>
          </div>
        {/each}
      {/if}
    </div>
  {/each}
</div>
