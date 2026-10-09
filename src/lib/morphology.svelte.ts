/**
 * Shared state for the Morphology activity: the left panel (classes, morphemes)
 * and the center view (features, endings) read and write the same store, so an
 * edit in one is immediately visible in the other.
 */

import * as api from "./api";
import { ui } from "./state.svelte";
import { POS_CLASSES } from "./dictionary";

class MorphologyStore {
  morphology = $state<api.Morphology>({ features: [], paradigms: [] });
  morphemes = $state<api.MorphemeInfo[]>([]);
  lexicon = $state<api.LexiconWord[]>([]);
  /** The class whose endings the editor is showing. */
  selectedClass = $state<string>("verb");
  /** The center sub-tab: the inflect preview or the paradigm editor. */
  tab = $state<"inflect" | "paradigms">("inflect");
  /** The lexicon word being inflected. */
  selectedWord = $state<string | null>(null);
  /** Feature selections for the preview. */
  selections = $state<api.FeatureSelections>({});
  /** Manually picked fixes-table morphemes (by wordname) for the preview. */
  manual = $state<string[]>([]);
  inflection = $state<api.Inflection | null>(null);
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
