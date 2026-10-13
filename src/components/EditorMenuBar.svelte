<!-- Editor menu bar: File/Edit/View/Tools/Metrics/Glyphs/Export. -->
<script lang="ts">
  import { editor } from "../lib/writingEditor.svelte";

  const MENUS = ["File", "Edit", "View", "Tools", "Metrics", "Glyphs", "Export"];

  function stub(label: string) {
    editor.status = `${label} menu (stub)`;
  }
</script>

<div class="editor-menubar">
  {#each MENUS as menu (menu)}
    <button class="menu-item" onclick={() => stub(menu)}>{menu}</button>
  {/each}
</div>
