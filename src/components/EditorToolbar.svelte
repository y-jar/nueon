<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    Bold,
    Italic,
    Underline,
    List,
    ListOrdered,
    SquareCode,
    Image,
    Table,
  } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import type { EditorView } from "@codemirror/view";
  import {
    toggleBold,
    toggleItalic,
    toggleUnderline,
    toggleBulletList,
    toggleNumberedList,
    toggleCodeBlock,
    insertTable,
    type FormatState,
  } from "../lib/editor/commands";

  interface Props {
    view: EditorView | null;
    format: FormatState;
    onImage: () => void;
    /** Extra controls placed at the right edge (export, …). */
    children?: Snippet;
  }

  let { view, format, onImage, children }: Props = $props();

  type Run = (view: EditorView) => boolean;

  /** Run an editor command, then hand focus back to the editor. */
  function run(command: Run) {
    if (!view) return;
    command(view);
    view.focus();
  }
</script>

<!-- mousedown is cancelled so a click never steals the editor's selection. -->
<div
  class="editor-toolbar"
  role="toolbar"
  tabindex="-1"
  aria-label={$t("editor.toolbar")}
  onmousedown={(e) => e.preventDefault()}
>
  <button
    class:active={format.bold}
    title="{$t('editor.bold')} (Ctrl+B)"
    aria-label={$t("editor.bold")}
    onclick={() => run(toggleBold)}
  >
    <Bold size={15} />
  </button>
  <button
    class:active={format.italic}
    title="{$t('editor.italic')} (Ctrl+I)"
    aria-label={$t("editor.italic")}
    onclick={() => run(toggleItalic)}
  >
    <Italic size={15} />
  </button>
  <button
    class:active={format.underline}
    title="{$t('editor.underline')} (Ctrl+U)"
    aria-label={$t("editor.underline")}
    onclick={() => run(toggleUnderline)}
  >
    <Underline size={15} />
  </button>

  <span class="toolbar-sep"></span>

  <button
    class:active={format.bullet}
    title={$t("editor.bulletList")}
    aria-label={$t("editor.bulletList")}
    onclick={() => run(toggleBulletList)}
  >
    <List size={15} />
  </button>
  <button
    class:active={format.ordered}
    title={$t("editor.numberedList")}
    aria-label={$t("editor.numberedList")}
    onclick={() => run(toggleNumberedList)}
  >
    <ListOrdered size={15} />
  </button>
  <button
    class:active={format.code}
    title="{$t('editor.codeBlock')} (Ctrl+Shift+C)"
    aria-label={$t("editor.codeBlock")}
    onclick={() => run(toggleCodeBlock)}
  >
    <SquareCode size={15} />
  </button>
  <button
    title={$t("editor.menu.table")}
    aria-label={$t("editor.menu.table")}
    onclick={() => run(insertTable)}
  >
    <Table size={15} />
  </button>

  <span class="toolbar-sep"></span>

  <button
    title={$t("editor.image")}
    aria-label={$t("editor.image")}
    onclick={onImage}
  >
    <Image size={15} />
  </button>

  <span class="grow"></span>
  {@render children?.()}
</div>
