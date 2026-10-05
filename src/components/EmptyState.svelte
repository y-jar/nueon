<script lang="ts">
  import { t } from "svelte-i18n";
  import { FilePlus, Table2, Languages, NotebookPen } from "@lucide/svelte";
  import type { NoteNode } from "../lib/api";
  import { ui, createNote, setActivity } from "../lib/state.svelte";

  let error = $state("");

  function collect(nodes: NoteNode[], out: Set<string>): void {
    for (const node of nodes) {
      if (!node.is_dir) out.add(node.path);
      if (node.children.length) collect(node.children, out);
    }
  }

  function uniqueNotePath(): string {
    const paths = new Set<string>();
    collect(ui.tree, paths);
    let name = "untitled";
    let n = 2;
    while (paths.has(name)) {
      name = `untitled ${n}`;
      n += 1;
    }
    return name;
  }

  async function newNote() {
    error = "";
    try {
      await createNote(uniqueNotePath());
    } catch (e) {
      error = String(e);
    }
  }
</script>

<div class="center-empty">
  <NotebookPen size={44} />
  <h2>{$t("tabs.emptyTitle")}</h2>
  <p class="muted">{$t("tabs.emptyHint")}</p>
  <div class="row">
    <button onclick={newNote}>
      <FilePlus size={15} /> {$t("tabs.newNote")}
    </button>
    <button onclick={() => setActivity("dictionary")}>
      <Table2 size={15} /> {$t("activity.dictionary")}
    </button>
    <button onclick={() => setActivity("translation")}>
      <Languages size={15} /> {$t("activity.translation")}
    </button>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
</div>
