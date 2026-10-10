//! Rewriting `[[...]]` wiki links when a word or note is renamed.

/// Rewrite every `[[old]]`, `[[old|alias]]`, `[[old#heading]]` and
/// `[[old#heading|alias]]` (plus `!` embeds) in `text` to point at `new`,
/// matching `old` case-insensitively and preserving the `#heading`, `|alias`
/// and the leading `!` embed marker. Any other text is left untouched.
pub fn rewrite_links(text: &str, old: &str, new: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    while let Some(rel) = text[pos..].find("[[") {
        let open = pos + rel;
        let embed = open > 0 && text.as_bytes()[open - 1] == b'!';
        let start = if embed { open - 1 } else { open };
        out.push_str(&text[pos..start]);
        let Some(rel_close) = text[open + 2..].find("]]") else {
            out.push_str(&text[start..]);
            pos = text.len();
            break;
        };
        let close = open + 2 + rel_close;
        let inner = &text[open + 2..close];
        let (before_pipe, alias) = match inner.split_once('|') {
            Some((target, alias)) => (target.trim(), Some(alias.trim())),
            None => (inner.trim(), None),
        };
        let (target, heading) = match before_pipe.split_once('#') {
            Some((target, heading)) => (target.trim(), Some(heading.trim())),
            None => (before_pipe, None),
        };
        if target.eq_ignore_ascii_case(old) {
            if embed {
                out.push('!');
            }
            out.push_str("[[");
            out.push_str(new);
            if let Some(heading) = heading {
                out.push('#');
                out.push_str(heading);
            }
            if let Some(alias) = alias {
                out.push('|');
                out.push_str(alias);
            }
            out.push_str("]]");
        } else {
            out.push_str(&text[start..close + 2]);
        }
        pos = close + 2;
    }
    out.push_str(&text[pos..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_plain_aliased_and_embed_links() {
        assert_eq!(rewrite_links("[[kala]]", "kala", "kaka"), "[[kaka]]");
        assert_eq!(
            rewrite_links("[[kala|dog]]", "kala", "kaka"),
            "[[kaka|dog]]"
        );
        assert_eq!(rewrite_links("![[kala]]", "kala", "kaka"), "![[kaka]]");
    }

    #[test]
    fn matches_case_insensitively_and_leaves_others_alone() {
        assert_eq!(
            rewrite_links("[[KALA]] and [[velo]]", "kala", "kaka"),
            "[[kaka]] and [[velo]]"
        );
    }

    #[test]
    fn rewrites_every_occurrence() {
        assert_eq!(
            rewrite_links("[[kala]] then [[kala|dog]]", "kala", "kaka"),
            "[[kaka]] then [[kaka|dog]]"
        );
    }

    #[test]
    fn no_links_is_unchanged() {
        assert_eq!(rewrite_links("plain text", "kala", "kaka"), "plain text");
    }

    #[test]
    fn preserves_heading_and_alias() {
        assert_eq!(
            rewrite_links("[[kala#nouns]]", "kala", "kaka"),
            "[[kaka#nouns]]"
        );
        assert_eq!(
            rewrite_links("[[kala#nouns|dog]]", "kala", "kaka"),
            "[[kaka#nouns|dog]]"
        );
        assert_eq!(
            rewrite_links("![[kala#nouns]]", "kala", "kaka"),
            "![[kaka#nouns]]"
        );
    }

    #[test]
    fn keeps_a_heading_when_renaming_a_word() {
        // A word target with a #heading keeps the #x text, losing nothing.
        assert_eq!(
            rewrite_links("[[kala#nouns|dog]]", "kala", "kaka"),
            "[[kaka#nouns|dog]]"
        );
    }
}
