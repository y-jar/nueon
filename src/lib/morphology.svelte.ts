//! Morphology store: classes, morphemes, paradigms and compose.
/**
 * Shared state for the Morphology activity: the left panel (classes, morphemes)
 * and the center view (features, endings) read and write the same store, so an
 * edit in one is immediately visible in the other.
 */

import * as api from "./api";
import { ui } from "./state.svelte";
import { POS_CLASSES } from "./dictionary";
import {
  consumerFresh,
  registerInvalidation,
  withOwnWrite,
} from "./invalidation.svelte";

/** The drag payload type for pieces dragged from the sidebar to the strip. */
export const PIECE_DRAG_TYPE = "application/x-nueon-piece";

/** A chip on the compose strip: enough to display and to rebuild a piece. */
export interface ComposeChip {
  key: string;
  kind: "word" | "morpheme";
  id: string;
  label: string;
  gloss: string;
  /** The backing word/morpheme vanished (deleted, or its table's role
   * changed): kept on the strip, struck out, not sent to compose. */
  missing?: boolean;
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
  /** Guards async reload continuations: only the newest reload writes. */
  private reloadGen = 0;

  /** Refetch everything and keep the user's work coherent. */
  async reload(): Promise<void> {
    const gen = ++this.reloadGen;
    try {
      const [morphology, morphemes, lexicon] = await Promise.all([
        api.translationMorphology(),
        api.listMorphemes(),
        api.lexicon(),
      ]);
      if (gen !== this.reloadGen) return;
      if (JSON.stringify(morphology) !== JSON.stringify(this.morphology)) {
        this.morphology = morphology;
      }
      if (JSON.stringify(morphemes) !== JSON.stringify(this.morphemes)) {
        this.morphemes = morphemes;
      }
      if (JSON.stringify(lexicon) !== JSON.stringify(this.lexicon)) {
        this.lexicon = lexicon;
      }
      this.reconcile(lexicon, morphemes);
      this.error = "";
    } catch (e) {
      if (gen === this.reloadGen) this.error = String(e);
    } finally {
      if (gen === this.reloadGen) this.loaded = true;
    }
  }

  /**
   * Keep the user's work coherent after an external reload: a deleted
   * selected word clears the preview; compose chips whose backing entry
   * vanished are marked missing instead of dropped.
   */
  private reconcile(
    lexicon: api.LexiconWord[],
    morphemes: api.MorphemeInfo[],
  ): void {
    if (
      this.selectedWord &&
      !lexicon.some((word) => word.id === this.selectedWord)
    ) {
      this.selectedWord = null;
      this.inflection = null;
      this.selections = {};
      this.manual = [];
    }
    let changed = false;
    const next = this.pieces.map((piece) => {
      const missing = !(
        piece.kind === "word"
          ? lexicon.some((word) => word.id === piece.id)
          : morphemes.some((morpheme) => morpheme.wordname === piece.id)
      );
      if (piece.missing !== missing) {
        changed = true;
        return { ...piece, missing };
      }
      return piece;
    });
    if (changed) {
      this.pieces = next;
      void this.runCompose();
    }
  }

  /** Load once; `force` refetches after an external change. */
  async load(force = false): Promise<void> {
    if (this.loaded && !force) return;
    await this.reload();
    consumerFresh("morphology");
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
      await withOwnWrite("morphology", ["translation"], () =>
        api.setTranslationMorphology(next),
      );
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

  /** Recompose the strip into a surface + breakdown (missing pieces sit out). */
  async runCompose(): Promise<void> {
    const active = this.pieces.filter((piece) => !piece.missing);
    if (active.length === 0) {
      this.composed = null;
      return;
    }
    try {
      this.composed = await api.compose(
        active.map((piece) =>
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

  /** Resolve a stored morpheme reference (id first, then legacy key). */
  resolveMorpheme(reference: api.MorphemeRef): api.MorphemeInfo | undefined {
    if (typeof reference === "string") {
      return this.morphemes.find(
        (morpheme) =>
          morpheme.wordname === reference || morpheme.triggers.includes(reference),
      );
    }
    return this.morphemes.find(
      (morpheme) =>
        morpheme.table === reference.table && morpheme.id === reference.id,
    );
  }

  /** The distinct tables that currently supply morphemes (Fixes tables). */
  fixesTables(): string[] {
    return [...new Set(this.morphemes.map((morpheme) => morpheme.table))];
  }

  /** Create a morpheme row in a Fixes table; returns the new morpheme. */
  async createMorpheme(
    table: string,
    surface: string,
    gloss: string,
  ): Promise<api.MorphemeInfo | null> {
    try {
      const id = await withOwnWrite("morphology", ["dictionary"], () =>
        api.createTranslationWord(table, surface, gloss, [], null),
      );
      if (!id) return null;
      this.morphemes = await api.listMorphemes();
      this.error = "";
      return this.morphemes.find((morpheme) => morpheme.id === id) ?? null;
    } catch (e) {
      this.error = String(e);
      return null;
    }
  }

  /**
   * Set the ending for one grid cell: replace (or create) the rule whose `slot`
   * and `when` exactly match, then persist.
   */
  async setCell(
    classId: string,
    slot: string | null,
    when: api.FeatureSelections,
    source: {
      zero?: boolean;
      morpheme?: api.MorphemeRef | null;
      surface?: string;
      kind?: api.AffixKind;
    },
  ): Promise<void> {
    const key = (w: api.FeatureSelections) =>
      JSON.stringify(Object.entries(w).sort(([a], [b]) => a.localeCompare(b)));
    const next: api.Morphology = {
      ...this.morphology,
      paradigms: this.morphology.paradigms.map((paradigm) => ({
        ...paradigm,
        rows: [...paradigm.rows],
      })),
    };
    let paradigm = next.paradigms.find((entry) => entry.class === classId);
    if (!paradigm) {
      paradigm = { class: classId, rows: [] };
      next.paradigms.push(paradigm);
    }
    const index = paradigm.rows.findIndex(
      (row) =>
        (row.slot ?? null) === (slot ?? null) && key(row.when) === key(when),
    );
    const order =
      index >= 0
        ? (paradigm.rows[index].order ?? 0)
        : paradigm.rows.reduce((max, row) => Math.max(max, row.order ?? 0), 0) + 1;
    paradigm.rows[index >= 0 ? index : paradigm.rows.length] = {
      when,
      slot,
      order,
      surface: source.surface ?? "",
      kind: source.kind ?? "suffix",
      morpheme: source.morpheme ?? null,
      zero: source.zero ?? false,
    };
    await this.save(next);
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

// The store follows `data-changed` events instead of loading once: word,
// table-role, translation-config, workspace and vcs changes each invalidate
// it. Hidden, it only goes stale and reloads when shown; its own writes
// (save, createMorpheme) are skipped so they cannot loop.
registerInvalidation({
  id: "morphology",
  scopes: ["dictionary", "config", "translation", "workspace", "vcs"],
  reload: () => morphology.reload(),
  visible: () =>
    ui.activity === "morphology" ||
    ui.groups.some((group) => group.doc.view === "morphology"),
  needsLoad: () => !morphology.loaded,
});
