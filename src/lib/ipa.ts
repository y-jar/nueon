//! IPA chart data and phoneme feature helpers.
/**
 * A curated IPA chart (pulmonic consonants and vowels) used only for display
 * and for mapping a clicked symbol to its class. The phonology itself stores
 * just `{ symbol, kind }`, so the core never needs this table.
 *
 * Conventional IPA spellings: `voiceless`/`voiced` consonant pairs, and
 * `unrounded`/`rounded` vowel pairs. Cells that the IPA chart leaves blank are
 * empty objects.
 */

export type PhonemeClass = "consonant" | "vowel";

/** A symbol offered by the chart, tagged with its class. */
export interface PhonemeOption {
  symbol: string;
  kind: PhonemeClass;
}

export interface Place {
  id: string;
  label: string;
}

export const PLACES: Place[] = [
  { id: "bilabial", label: "Bilabial" },
  { id: "labiodental", label: "Labiodental" },
  { id: "dental", label: "Dental" },
  { id: "alveolar", label: "Alveolar" },
  { id: "postalveolar", label: "Postalveolar" },
  { id: "retroflex", label: "Retroflex" },
  { id: "palatal", label: "Palatal" },
  { id: "velar", label: "Velar" },
  { id: "uvular", label: "Uvular" },
  { id: "pharyngeal", label: "Pharyngeal" },
  { id: "glottal", label: "Glottal" },
];

export interface Backness {
  id: string;
  label: string;
}

export const BACKNESS: Backness[] = [
  { id: "front", label: "Front" },
  { id: "central", label: "Central" },
  { id: "back", label: "Back" },
];

export interface ConsonantCell {
  voiceless?: string;
  voiced?: string;
}

export interface ConsonantRow {
  manner: string;
  /** One entry per place, in `PLACES` order. */
  cells: ConsonantCell[];
}

export const CONSONANTS: ConsonantRow[] = [
  {
    manner: "Plosive",
    cells: [
      { voiceless: "p", voiced: "b" },
      {},
      { voiceless: "t̪", voiced: "d̪" },
      { voiceless: "t", voiced: "d" },
      {},
      { voiceless: "ʈ", voiced: "ɖ" },
      { voiceless: "c", voiced: "ɟ" },
      { voiceless: "k", voiced: "ɡ" },
      { voiceless: "q", voiced: "ɢ" },
      {},
      { voiceless: "ʔ" },
    ],
  },
  {
    manner: "Nasal",
    cells: [
      { voiced: "m" },
      { voiced: "ɱ" },
      { voiced: "n̪" },
      { voiced: "n" },
      {},
      { voiced: "ɳ" },
      { voiced: "ɲ" },
      { voiced: "ŋ" },
      { voiced: "ɴ" },
      {},
      {},
    ],
  },
  {
    manner: "Trill",
    cells: [
      { voiced: "ʙ" },
      {},
      {},
      { voiced: "r" },
      {},
      {},
      {},
      {},
      { voiced: "ʀ" },
      {},
      {},
    ],
  },
  {
    manner: "Tap/Flap",
    cells: [
      {},
      { voiced: "ⱱ" },
      {},
      { voiced: "ɾ" },
      {},
      { voiced: "ɽ" },
      {},
      {},
      {},
      {},
      {},
    ],
  },
  {
    manner: "Fricative",
    cells: [
      { voiceless: "ɸ", voiced: "β" },
      { voiceless: "f", voiced: "v" },
      { voiceless: "θ", voiced: "ð" },
      { voiceless: "s", voiced: "z" },
      { voiceless: "ʃ", voiced: "ʒ" },
      { voiceless: "ʂ", voiced: "ʐ" },
      { voiceless: "ç", voiced: "ʝ" },
      { voiceless: "x", voiced: "ɣ" },
      { voiceless: "χ", voiced: "ʁ" },
      { voiceless: "ħ", voiced: "ʕ" },
      { voiceless: "h", voiced: "ɦ" },
    ],
  },
  {
    manner: "Lateral fricative",
    cells: [
      {},
      {},
      {},
      { voiceless: "ɬ", voiced: "ɮ" },
      {},
      {},
      {},
      {},
      {},
      {},
      {},
    ],
  },
  {
    manner: "Approximant",
    cells: [
      {},
      { voiced: "ʋ" },
      {},
      { voiced: "ɹ" },
      {},
      { voiced: "ɻ" },
      { voiced: "j" },
      { voiced: "ɰ" },
      {},
      {},
      {},
    ],
  },
  {
    manner: "Lateral approximant",
    cells: [
      {},
      {},
      {},
      { voiced: "l" },
      {},
      { voiced: "ɭ" },
      { voiced: "ʎ" },
      { voiced: "ʟ" },
      {},
      {},
      {},
    ],
  },
];

export interface VowelCell {
  unrounded?: string;
  rounded?: string;
}

export interface VowelRow {
  height: string;
  /** One entry per backness, in `BACKNESS` order. */
  cells: VowelCell[];
}

export const VOWELS: VowelRow[] = [
  {
    height: "Close",
    cells: [{ unrounded: "i", rounded: "y" }, { unrounded: "ɨ", rounded: "ʉ" }, { unrounded: "ɯ", rounded: "u" }],
  },
  {
    height: "Near-close",
    cells: [{ unrounded: "ɪ", rounded: "ʏ" }, {}, { rounded: "ʊ" }],
  },
  {
    height: "Close-mid",
    cells: [{ unrounded: "e", rounded: "ø" }, { unrounded: "ɘ", rounded: "ɵ" }, { unrounded: "ɤ", rounded: "o" }],
  },
  {
    height: "Mid",
    cells: [{}, { unrounded: "ə" }, {}],
  },
  {
    height: "Open-mid",
    cells: [{ unrounded: "ɛ", rounded: "œ" }, { unrounded: "ɜ", rounded: "ɞ" }, { unrounded: "ʌ", rounded: "ɔ" }],
  },
  {
    height: "Near-open",
    cells: [{ unrounded: "æ" }, { unrounded: "ɐ" }, {}],
  },
  {
    height: "Open",
    cells: [{ unrounded: "a", rounded: "ɶ" }, {}, { unrounded: "ɑ", rounded: "ɒ" }],
  },
];

/** Every symbol the chart offers, de-duplicated, tagged with its class. */
export function chartSymbols(): PhonemeOption[] {
  const out: PhonemeOption[] = [];
  const seen = new Set<string>();
  const add = (symbol: string | undefined, kind: PhonemeClass) => {
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    out.push({ symbol, kind });
  };
  for (const row of CONSONANTS) {
    for (const cell of row.cells) {
      add(cell.voiceless, "consonant");
      add(cell.voiced, "consonant");
    }
  }
  for (const row of VOWELS) {
    for (const cell of row.cells) {
      add(cell.unrounded, "vowel");
      add(cell.rounded, "vowel");
    }
  }
  return out;
}
