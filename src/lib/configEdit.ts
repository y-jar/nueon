/**
 * Pure edits to the phonology and morphology config, shared by Settings.
 *
 * Kept free of Svelte and Tauri so the rebuild rules — how the consonant and
 * vowel lists map back onto the inventory, and how the noun plural ending is
 * inserted without disturbing other paradigms — can be unit-tested directly.
 */

import type { AffixKind, Morphology, ParadigmRow } from "./api";

export type PhonemeKind = "consonant" | "vowel" | "other";

export interface Phoneme {
  symbol: string;
  kind: PhonemeKind;
}

/** Split a space/comma separated symbol list, dropping blanks and duplicates. */
export function parseSymbolList(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map((symbol) => symbol.trim())
        .filter(Boolean),
    ),
  ];
}

/** The consonant and vowel symbols of an inventory, as editable text. */
export function splitSoundClasses(phonemes: Phoneme[]): {
  consonants: string;
  vowels: string;
} {
  return {
    consonants: phonemes
      .filter((phoneme) => phoneme.kind === "consonant")
      .map((phoneme) => phoneme.symbol)
      .join(" "),
    vowels: phonemes
      .filter((phoneme) => phoneme.kind === "vowel")
      .map((phoneme) => phoneme.symbol)
      .join(" "),
  };
}

/**
 * Rebuild an inventory from edited consonant/vowel text. `others` are the
 * unclassified sounds to keep; any that reappear in a list are reclassified
 * rather than duplicated. A symbol in both lists is a consonant.
 */
export function rebuildPhonemes(
  consonants: string,
  vowels: string,
  others: Phoneme[],
): Phoneme[] {
  const consonantSymbols = parseSymbolList(consonants);
  const consonantSet = new Set(consonantSymbols);
  const rebuilt: Phoneme[] = [
    ...consonantSymbols.map((symbol) => ({
      symbol,
      kind: "consonant" as const,
    })),
    ...parseSymbolList(vowels)
      .filter((symbol) => !consonantSet.has(symbol))
      .map((symbol) => ({ symbol, kind: "vowel" as const })),
  ];
  const placed = new Set(rebuilt.map((phoneme) => phoneme.symbol));
  for (const other of others) {
    if (!placed.has(other.symbol)) {
      rebuilt.push(other);
      placed.add(other.symbol);
    }
  }
  return rebuilt;
}

/** The noun paradigm's plural row, if one exists. */
export function pluralEnding(
  morphology: Morphology,
): ParadigmRow | undefined {
  const noun = morphology.paradigms.find((p) => p.class === "noun");
  return noun?.rows.find((row) => row.when.number === "plural");
}

/**
 * Return `morphology` with the noun plural ending set. Creates the noun
 * paradigm and/or plural row when missing, and leaves every other row and
 * paradigm as it is.
 */
export function setPluralEnding(
  morphology: Morphology,
  surface: string,
  kind: AffixKind,
): Morphology {
  const paradigms = morphology.paradigms.map((paradigm) => ({
    ...paradigm,
    rows: [...paradigm.rows],
  }));
  let noun = paradigms.find((paradigm) => paradigm.class === "noun");
  if (!noun) {
    noun = { class: "noun", rows: [] };
    paradigms.push(noun);
  }
  const index = noun.rows.findIndex((row) => row.when.number === "plural");
  const existing = index >= 0 ? noun.rows[index] : undefined;
  // Keep any slot/order/morpheme the plural row already carried.
  const row: ParadigmRow = { ...existing, when: { ...existing?.when, number: "plural" }, surface, kind };
  if (index >= 0) noun.rows[index] = row;
  else noun.rows.push(row);
  return { ...morphology, paradigms };
}
