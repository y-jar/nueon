//! English misspelling guard for `definition` fields (PSD §B).
//!
//! Backed by `nspell` and the bundled `dictionary-en` word list. The dictionary
//! is loaded lazily so the (large) word list never blocks the initial render,
//! and is never applied to conlang `wordname` fields.

interface SpellChecker {
  correct(word: string): boolean;
  suggest(word: string, limit?: number): string[];
  add(word: string): void;
  remove(word: string): void;
}

let checker: SpellChecker | null = null;
let loading: Promise<SpellChecker> | null = null;

async function load(): Promise<SpellChecker> {
  if (checker) return checker;
  if (!loading) {
    loading = (async () => {
      const [aff, dic, nspell] = await Promise.all([
        import("../../node_modules/dictionary-en/index.aff?raw"),
        import("../../node_modules/dictionary-en/index.dic?raw"),
        import("nspell"),
      ]);
      checker = nspell.default({ aff: aff.default, dic: dic.default });
      return checker;
    })();
  }
  return loading;
}

const WORD = /[A-Za-z][A-Za-z'-]*/g;

/** Unique words in `text` the English dictionary does not recognise. */
export async function misspelledWords(text: string): Promise<string[]> {
  if (!text.trim()) return [];
  let spell: SpellChecker;
  try {
    spell = await load();
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (lower.length < 3 || seen.has(lower)) continue;
    seen.add(lower);
    if (!spell.correct(lower)) result.push(word);
  }
  return result;
}

/** Spelling suggestions for a word (best first). */
export async function spellSuggestions(
  word: string,
  limit = 5,
): Promise<string[]> {
  try {
    const spell = await load();
    return spell.suggest(word).slice(0, limit);
  } catch {
    return [];
  }
}
