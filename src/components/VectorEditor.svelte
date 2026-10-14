<!-- Vector editor: menu, toolbar, toolbox, canvas, metrics and tray. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { ArrowLeft } from "@lucide/svelte";
  import type { GlyphMeta, Phoneme, WritingConfig } from "../lib/api";
  import { editor } from "../lib/writingEditor.svelte";
  import { neighbourGlyph, type GuideField } from "../lib/writingMenus";
  import EditorMenuBar from "./EditorMenuBar.svelte";
  import VectorToolbar from "./VectorToolbar.svelte";
  import Toolbox from "./Toolbox.svelte";
  import RadicalPalette from "./RadicalPalette.svelte";
  import GlyphCanvas from "./GlyphCanvas.svelte";
  import CompositionMatrix from "./CompositionMatrix.svelte";
  import GlyphMetricsPanel from "./GlyphMetricsPanel.svelte";
  import PathfinderPanel from "./PathfinderPanel.svelte";
  import GlyphGridTray from "./GlyphGridTray.svelte";
  import EditorStatusBar from "./EditorStatusBar.svelte";
  import FontReportDialog from "./FontReportDialog.svelte";

  interface Props {
    config: WritingConfig;
    phonemes: Phoneme[];
    onClose: () => void;
    onOpen: (glyph: GlyphMeta) => void;
    onAdd: () => void;
    onCompose: (row: GlyphMeta, col: GlyphMeta) => void;
    onDuplicate: (id: string) => void;
    onDelete: (id: string) => void;
    onGuideChange: (field: GuideField, value: number) => void;
    onGlyphChange: (glyph: GlyphMeta) => void;
    onBatchDelete: (ids: string[]) => void;
    onBatchGroup: (ids: string[], group: string) => void;
    onBatchAdvance: (ids: string[], advance: number) => void;
    onBatchExport: (ids: string[]) => void;
  }

  let {
    config,
    phonemes,
    onClose,
    onOpen,
    onAdd,
    onCompose,
    onDuplicate,
    onDelete,
    onGuideChange,
    onGlyphChange,
    onBatchDelete,
    onBatchGroup,
    onBatchAdvance,
    onBatchExport,
  }: Props = $props();

  function step(delta: 1 | -1) {
    const ids = config.glyphs.map((g) => g.id);
    const next = neighbourGlyph(ids, editor.openGlyphId, delta);
    const glyph = config.glyphs.find((g) => g.id === next);
    if (glyph) onOpen(glyph);
  }
</script>

<div class="vector-editor">
  <div class="editor-top">
    <button class="back" title={$t("writing.back")} onclick={onClose}>
      <ArrowLeft size={16} />
    </button>
    <EditorMenuBar
      {config}
      {onClose}
      onNewGlyph={onAdd}
      onDuplicateGlyph={() => editor.openGlyphId && onDuplicate(editor.openGlyphId)}
      onDeleteGlyph={() => editor.openGlyphId && onDelete(editor.openGlyphId)}
      onStepGlyph={step}
      {onGuideChange}
    />
  </div>

  <VectorToolbar />

  <div class="editor-main">
    <div class="editor-side">
      <Toolbox />
      <RadicalPalette glyphs={config.glyphs} />
    </div>

    {#if editor.composeOpen}
      <CompositionMatrix glyphs={config.glyphs} {onCompose} />
    {:else}
      <GlyphCanvas {config} />
    {/if}

    <div class="editor-side">
      <GlyphMetricsPanel {phonemes} glyphs={config.glyphs} {onGlyphChange} />
      <PathfinderPanel />
    </div>
  </div>

  <EditorStatusBar />
  <GlyphGridTray
    glyphs={config.glyphs}
    currentId={editor.openGlyphId}
    {onOpen}
    {onAdd}
    {onBatchDelete}
    {onBatchGroup}
    {onBatchAdvance}
    {onBatchExport}
  />

  {#if editor.error}<p class="error">{editor.error}</p>{/if}
  <FontReportDialog />
</div>
