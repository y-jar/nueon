<!-- Vector editor: menu, toolbar, toolbox, canvas, metrics and tray. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { ArrowLeft } from "@lucide/svelte";
  import type { GlyphMeta, Phoneme, WritingConfig } from "../lib/api";
  import { editor } from "../lib/writingEditor.svelte";
  import EditorMenuBar from "./EditorMenuBar.svelte";
  import VectorToolbar from "./VectorToolbar.svelte";
  import Toolbox from "./Toolbox.svelte";
  import GlyphCanvas from "./GlyphCanvas.svelte";
  import GlyphMetricsPanel from "./GlyphMetricsPanel.svelte";
  import GlyphGridTray from "./GlyphGridTray.svelte";
  import EditorStatusBar from "./EditorStatusBar.svelte";

  interface Props {
    config: WritingConfig;
    phonemes: Phoneme[];
    onClose: () => void;
    onOpen: (glyph: GlyphMeta) => void;
    onAdd: () => void;
  }

  let { config, phonemes, onClose, onOpen, onAdd }: Props = $props();
</script>

<div class="vector-editor">
  <div class="editor-top">
    <button class="back" title={$t("writing.back")} onclick={onClose}>
      <ArrowLeft size={16} />
    </button>
    <EditorMenuBar />
  </div>

  <VectorToolbar />

  <div class="editor-main">
    <Toolbox />
    <GlyphCanvas {config} />
    <GlyphMetricsPanel {phonemes} />
  </div>

  <EditorStatusBar />
  <GlyphGridTray glyphs={config.glyphs} currentId={editor.openGlyphId} {onOpen} {onAdd} />

  {#if editor.error}<p class="error">{editor.error}</p>{/if}
</div>
