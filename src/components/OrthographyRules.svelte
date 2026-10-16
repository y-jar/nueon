<!-- Orthography rules: letters in, glyphs out, in an optional context. Order matters. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { ArrowDown, ArrowUp, Plus, X } from "@lucide/svelte";
  import type { GlyphMeta, OrthographyRule } from "../lib/api";
  import {
    addRule,
    describeRule,
    formatTargets,
    moveRule,
    parseTargets,
    removeRule,
    updateRule,
  } from "../lib/writingRules";

  interface Props {
    rules: OrthographyRule[];
    glyphs: GlyphMeta[];
    onChange: (rules: OrthographyRule[]) => void;
  }

  let { rules, glyphs, onChange }: Props = $props();

  let drafts = $state<Record<number, string>>({});

  function shownTargets(index: number): string {
    return drafts[index] ?? formatTargets(rules[index].to, glyphs);
  }

  function unknownIn(index: number): string[] {
    const text = drafts[index];
    return text === undefined ? [] : parseTargets(text, glyphs).unknown;
  }

  function editTargets(index: number, text: string) {
    drafts[index] = text;
    onChange(updateRule(rules, index, { to: parseTargets(text, glyphs).ids }));
  }

  function settled(index: number) {
    delete drafts[index];
  }

  function remove(index: number) {
    drafts = {};
    onChange(removeRule(rules, index));
  }

  function move(index: number, delta: -1 | 1) {
    drafts = {};
    onChange(moveRule(rules, index, delta));
  }
</script>

<section class="orthography" data-testid="orthography-rules">
  <h3>{$t("writing.rules.title")}</h3>
  <p class="muted">{$t("writing.rules.hint")}</p>
  {#if rules.length === 0}
    <p class="muted">{$t("writing.rules.none")}</p>
  {/if}
  {#each rules as rule, index (index)}
    <div class="rule-row" data-testid="orthography-rule">
      <input
        placeholder={$t("writing.rules.from")}
        aria-label={$t("writing.rules.from")}
        value={rule.from}
        oninput={(e) => onChange(updateRule(rules, index, { from: e.currentTarget.value }))}
      />
      <span class="muted">&rarr;</span>
      <input
        class="grow"
        class:invalid={unknownIn(index).length > 0}
        placeholder={$t("writing.rules.to")}
        aria-label={$t("writing.rules.to")}
        title={unknownIn(index).length > 0
          ? $t("writing.rules.unknown", { values: { names: unknownIn(index).join(", ") } })
          : ""}
        value={shownTargets(index)}
        oninput={(e) => editTargets(index, e.currentTarget.value)}
        onblur={() => settled(index)}
      />
      <span class="muted">/</span>
      <input
        class="context"
        placeholder="C"
        aria-label={$t("writing.rules.left")}
        value={rule.left ?? ""}
        oninput={(e) => onChange(updateRule(rules, index, { left: e.currentTarget.value }))}
      />
      <span class="muted">_</span>
      <input
        class="context"
        placeholder="#"
        aria-label={$t("writing.rules.right")}
        value={rule.right ?? ""}
        oninput={(e) => onChange(updateRule(rules, index, { right: e.currentTarget.value }))}
      />
      <button
        title={$t("writing.rules.up")}
        disabled={index === 0}
        onclick={() => move(index, -1)}
      >
        <ArrowUp size={13} />
      </button>
      <button
        title={$t("writing.rules.down")}
        disabled={index === rules.length - 1}
        onclick={() => move(index, 1)}
      >
        <ArrowDown size={13} />
      </button>
      <button title={$t("writing.rules.remove")} onclick={() => remove(index)}>
        <X size={13} />
      </button>
    </div>
    {#if unknownIn(index).length > 0}
      <p class="rule-warning">
        {$t("writing.rules.unknown", { values: { names: unknownIn(index).join(", ") } })}
      </p>
    {/if}
  {/each}
  <div class="custom-row">
    <button
      title={$t("writing.rules.addHint")}
      onclick={() => onChange(addRule(rules))}
    >
      <Plus size={14} /> {$t("writing.rules.add")}
    </button>
  </div>
  {#if rules.length > 0}
    <ol class="rule-summary" aria-label={$t("writing.rules.order")}>
      {#each rules as rule, index (index)}
        <li>{describeRule(rule, glyphs)}</li>
      {/each}
    </ol>
  {/if}
</section>
