//! Bracket auto-closing language data.
/**
 * Bracket auto-closing for the note editor.
 *
 * Only parentheses, square and curly brackets close: quote and apostrophe
 * characters stay untouched (they are common in conlang text and editors that
 * auto-close them fight the user). The bracket set is pinned explicitly rather
 * than relying on `closeBrackets`'s defaults, which include `'` and `"`.
 */
import { closeBrackets } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";

/** The characters that pair up when typed. */
export const AUTO_CLOSE_BRACKETS = ["(", "[", "{"];

/** Language data that pins the brackets `closeBrackets` may close. */
export const closeBracketsLanguageData = EditorState.languageData.of(() => [
  {
    closeBrackets: {
      brackets: [...AUTO_CLOSE_BRACKETS],
      before: ")]}:;>",
      stringPrefixes: [],
    },
  },
]);

/** The `closeBrackets` extension plus the bracket set it should use. */
export function bracketAutoClose() {
  return [closeBrackets(), closeBracketsLanguageData];
}
