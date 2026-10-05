<script lang="ts">
  import { t } from "svelte-i18n";
  import type { InterlinearGloss } from "../lib/api";

  let { gloss }: { gloss: InterlinearGloss } = $props();
  let copied = $state("");

  function toPlain(): string {
    const widths = gloss.morphemes.map((morpheme) =>
      Math.max(morpheme.surface.length, morpheme.gloss.length),
    );
    const surface = gloss.morphemes
      .map((morpheme, i) => morpheme.surface.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
    const line2 = gloss.morphemes
      .map((morpheme, i) => morpheme.gloss.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
    return `${surface}\n${line2}\n'${gloss.translation}'`;
  }

  function toMarkdown(): string {
    const header = `| ${gloss.morphemes.map((m) => m.surface).join(" | ")} |`;
    const separator = `| ${gloss.morphemes.map(() => "---").join(" | ")} |`;
    const body = `| ${gloss.morphemes.map((m) => m.gloss).join(" | ")} |`;
    return `${header}\n${separator}\n${body}\n\n_${gloss.translation}_`;
  }

  function toLatex(): string {
    const surface = gloss.morphemes.map((m) => m.surface).join(" & ");
    const line2 = gloss.morphemes.map((m) => m.gloss).join(" & ");
    return `\\gll ${surface} \\\\\n     ${line2} \\\\\n\\glt \`${gloss.translation}'`;
  }

  async function copy(kind: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = kind;
      setTimeout(() => {
        if (copied === kind) copied = "";
      }, 1200);
    } catch {
      // Clipboard unavailable; ignore.
    }
  }
</script>

{#if gloss.morphemes.length}
  <div class="interlinear">
    <div class="section-title">{$t("translation.gloss")}</div>
    <div
      class="gloss-table mono"
      style="grid-template-columns: repeat({gloss.morphemes.length}, max-content)"
    >
      {#each gloss.morphemes as morpheme, i (i)}
        <span>{morpheme.surface}</span>
      {/each}
      {#each gloss.morphemes as morpheme, i (i)}
        <span class="gloss-morph">{morpheme.gloss}</span>
      {/each}
    </div>
    <div class="gloss-translation">{gloss.translation}</div>
    <div class="row">
      <button onclick={() => copy("text", toPlain())}
        >{copied === "text"
          ? $t("translation.copied")
          : $t("translation.copyText")}</button
      >
      <button onclick={() => copy("markdown", toMarkdown())}
        >{copied === "markdown"
          ? $t("translation.copied")
          : $t("translation.copyMarkdown")}</button
      >
      <button onclick={() => copy("latex", toLatex())}
        >{copied === "latex"
          ? $t("translation.copied")
          : $t("translation.copyLatex")}</button
      >
    </div>
  </div>
{/if}
