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
  /** The class whose endings the editor is showing. */
  selectedClass = $state<string>("verb");
  loaded = $state(false);
  error = $state("");

  /** Load the config once; `force` refetches after an external change. */
  async load(force = false): Promise<void> {
    if (this.loaded && !force) return;
    try {
      const [morphology, morphemes] = await Promise.all([
        api.translationMorphology(),
        api.listMorphemes(),
      ]);
      this.morphology = morphology;
      this.morphemes = morphemes;
      this.error = "";
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loaded = true;
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
