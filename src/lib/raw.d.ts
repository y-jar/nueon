//! Module declarations for assets imported without types.
declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "nspell" {
  interface SpellChecker {
    correct(word: string): boolean;
    suggest(word: string, limit?: number): string[];
    add(word: string): void;
    remove(word: string): void;
  }

  interface Dictionary {
    aff: string | Uint8Array;
    dic: string | Uint8Array;
  }

  function nspell(dictionary: Dictionary | Dictionary[]): SpellChecker;
  function nspell(aff: string | Uint8Array, dic: string | Uint8Array): SpellChecker;

  export default nspell;
}
