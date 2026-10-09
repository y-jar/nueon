/**
 * Shared state for the Morphology activity: the left panel (classes, morphemes)
 * and the center view (features, endings) read and write the same store, so an
 * edit in one is immediately visible in the other.
 */

import * as api from "./api";
import { ui } from "./state.svelte";
import { POS_CLASSES } from "./dictionary";

/** The drag payload type for pieces dragged from the sidebar to the strip. */
export const PIECE_DRAG_TYPE = "application/x-nueon-piece";

/** A chip on the compose strip: enough to display and to rebuild a piece. */
export interface ComposeChip {
  key: string;
  kind: "word" | "morpheme";
  id: string;
  label: string;
  gloss: string;
}

class MorphologyStore {
  morphology = $state<api.Morphology>({ features: [], paradigms: [] });
  morphemes = $state<api.MorphemeInfo[]>([]);
  lexicon = $state<api.LexiconWord[]>([]);
  /** The class whose endings the editor is showing. */
  selectedClass = $state<string>("verb");
  /** The center sub-tab: compose, the inflect preview, or the paradigm editor. */
  tab = $state<"compose" | "inflect" | "paradigms">("compose");
  /** The lexicon word being inflected. */
  selectedWord = $state<string | null>(null);
  /** Feature selections for the preview. */
  selections = $state<api.FeatureSelections>({});
  /** Manually picked fixes-table morphemes (by wordname) for the preview. */
  manual = $state<string[]>([]);
  inflection = $state<api.Inflection | null>(null);
  /** The ordered chips being combined in the Compose builder. */
  pieces = $state<ComposeChip[]>([]);
  composed = $state<api.Inflection | null>(null);
  loaded = $state(false);
  error = $state("");

  /** Load the config once; `force` refetches after an external change. */
  async load(force = false): Promise<void> {
    if (this.loaded && !force) return;
    try {
      const [morphology, morphemes, lexicon] = await Promise.all([
        api.translationMorphology(),
        api.listMorphemes(),
        api.lexicon(),
      ]);
      this.morphology = morphology;
      this.morphemes = morphemes;
      this.lexicon = lexicon;
      this.error = "";
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loaded = true;
    }
  }

  /** Point the preview at a lexicon word and clear the per-word picks. */
  selectWord(id: string): void {
    this.selectedWord = id;
    this.selections = {};
    this.manual = [];
    this.tab = "inflect";
  }

  /** Select / clear one feature value. */
  toggleFeature(featureId: string, valueId: string): void {
    if (this.selections[featureId] === valueId) {
      const next = { ...this.selections };
      delete next[featureId];
      this.selections = next;
    } else {
      this.selections = { ...this.selections, [featureId]: valueId };
    }
  }

  /** Add / remove a manually applied morpheme. */
  toggleMorpheme(wordname: string): void {
    this.manual = this.manual.includes(wordname)
      ? this.manual.filter((name) => name !== wordname)
      : [...this.manual, wordname];
  }

  /** Recompute the current word's inflection. */
  async refreshInflection(): Promise<void> {
    if (!this.selectedWord) {
      this.inflection = null;
      return;
    }
    try {
      this.inflection = await api.inflectWord(
        this.selectedWord,
        { ...this.selections },
        [...this.manual],
      );
      this.error = "";
    } catch (e) {
      this.error = String(e);
    }
  }

  /** Replace the whole morphology config and persist it. */
  async save(next: api.Morphology): Promise<void> {
    this.morphology = next;
    try {
      await api.setTranslationMorphology(next);
      ui.morphologyRevision += 1;
      this.error = "";
    } catch (e) {
      this.error = String(e);
    }
  }

  /** Add a piece by kind + id (drag-drop / Enter), resolving it in the loaded lists. */
  addPieceRef(kind: "word" | "morpheme", id: string): void {
    if (kind === "word") {
      const word = this.lexicon.find((entry) => entry.id === id);
      if (word) this.addWord(word);
    } else {
      const morpheme = this.morphemes.find((entry) => entry.wordname === id);
      if (morpheme) this.addMorpheme(morpheme);
    }
  }

  /** Append a vocabulary word to the compose strip. */
  addWord(word: api.LexiconWord): void {
    this.pieces = [
      ...this.pieces,
      {
        key: crypto.randomUUID(),
        kind: "word",
        id: word.id,
        label: word.wordname,
        gloss: word.gloss,
      },
    ];
    void this.runCompose();
  }

  /** Append a fixes-table morpheme to the compose strip. */
  addMorpheme(morpheme: api.MorphemeInfo): void {
    this.pieces = [
      ...this.pieces,
      {
        key: crypto.randomUUID(),
        kind: "morpheme",
        id: morpheme.wordname,
        label: morpheme.surface,
        gloss: morpheme.gloss,
      },
    ];
    void this.runCompose();
  }

  removeChip(key: string): void {
    this.pieces = this.pieces.filter((piece) => piece.key !== key);
    void this.runCompose();
  }

  /** Move a chip one position left (`-1`) or right (`+1`). */
  moveChip(key: string, delta: number): void {
    const index = this.pieces.findIndex((piece) => piece.key === key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= this.pieces.length) return;
    const next = [...this.pieces];
    [next[index], next[target]] = [next[target], next[index]];
    this.pieces = next;
    void this.runCompose();
  }

  clearStrip(): void {
    this.pieces = [];
    this.composed = null;
  }

  /** Recompose the strip into a surface + breakdown. */
  async runCompose(): Promise<void> {
    if (this.pieces.length === 0) {
      this.composed = null;
      return;
    }
    try {
      this.composed = await api.compose(
        this.pieces.map((piece) =>
          piece.kind === "word"
            ? ({ kind: "word", id: piece.id } as const)
            : ({ kind: "morpheme", id: piece.id } as const),
        ),
      );
      this.error = "";
    } catch (e) {
      this.error = String(e);
    }
  }

  /** The built-in word classes plus any class that already has a paradigm. */
  classNames(): string[] {
    return [
      ...new Set([
        ...POS_CLASSES,
        ...this.morphology.paradigms.map((paradigm) => paradigm.class),
      ]),
    ];
  }
}

export const morphology = new MorphologyStore();
