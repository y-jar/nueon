//! Line-based Markdown region parser.
//!
//! The editor reveals raw syntax for one region at a time, so the document is
//! split into regions that map cleanly onto source byte ranges. Most regions
//! are a single line; fenced code blocks and block quotes may span several.

use std::ops::Range;

/// What kind of block a region represents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RegionKind {
    Heading(u8),
    Paragraph,
    ListItem { ordered: bool, marker: String },
    BlockQuote,
    CodeBlock { lang: String },
    Rule,
    Blank,
}

/// A region of the source document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Region {
    pub kind: RegionKind,
    /// Byte range of the region's content, excluding its trailing newline.
    pub content: Range<usize>,
}

struct Line<'a> {
    start: usize,
    content: &'a str,
}

/// Split a Markdown document into editable regions.
pub fn parse_regions(source: &str) -> Vec<Region> {
    let lines = collect_lines(source);
    let mut regions = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let line = &lines[i];
        let trimmed = line.content.trim_start();
        let line_end = line.start + line.content.len();

        if let Some(fence_char) = fence_marker(trimmed) {
            let start = line.start;
            let mut end = line_end;
            let mut next = i + 1;
            let mut closed = false;
            while next < lines.len() {
                let candidate = &lines[next];
                end = candidate.start + candidate.content.len();
                if fence_marker(candidate.content.trim_start()) == Some(fence_char) {
                    closed = true;
                    next += 1;
                    break;
                }
                next += 1;
            }
            regions.push(Region {
                kind: RegionKind::CodeBlock {
                    lang: fence_lang(trimmed),
                },
                content: start..end,
            });
            i = if closed { next } else { lines.len() };
            continue;
        }

        if trimmed.is_empty() {
            regions.push(Region {
                kind: RegionKind::Blank,
                content: line.start..line_end,
            });
            i += 1;
            continue;
        }

        if let Some(level) = heading_level(trimmed) {
            regions.push(Region {
                kind: RegionKind::Heading(level),
                content: line.start..line_end,
            });
            i += 1;
            continue;
        }

        if is_rule(trimmed) {
            regions.push(Region {
                kind: RegionKind::Rule,
                content: line.start..line_end,
            });
            i += 1;
            continue;
        }

        if trimmed.starts_with('>') {
            let start = line.start;
            let mut end = line_end;
            let mut next = i + 1;
            while next < lines.len() && lines[next].content.trim_start().starts_with('>') {
                end = lines[next].start + lines[next].content.len();
                next += 1;
            }
            regions.push(Region {
                kind: RegionKind::BlockQuote,
                content: start..end,
            });
            i = next;
            continue;
        }

        if let Some((ordered, marker)) = list_marker(trimmed) {
            regions.push(Region {
                kind: RegionKind::ListItem { ordered, marker },
                content: line.start..line_end,
            });
            i += 1;
            continue;
        }

        regions.push(Region {
            kind: RegionKind::Paragraph,
            content: line.start..line_end,
        });
        i += 1;
    }

    regions
}

fn collect_lines(source: &str) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    let mut start = 0;
    for chunk in source.split_inclusive('\n') {
        let content = chunk.strip_suffix('\n').unwrap_or(chunk);
        let content = content.strip_suffix('\r').unwrap_or(content);
        lines.push(Line { start, content });
        start += chunk.len();
    }
    lines
}

/// Returns the fence character if the line opens a fenced code block.
pub(crate) fn fence_marker(trimmed: &str) -> Option<char> {
    if trimmed.starts_with("```") {
        Some('`')
    } else if trimmed.starts_with("~~~") {
        Some('~')
    } else {
        None
    }
}

fn fence_lang(trimmed: &str) -> String {
    trimmed
        .chars()
        .skip_while(|c| *c == '`' || *c == '~')
        .collect::<String>()
        .trim()
        .to_string()
}

fn heading_level(trimmed: &str) -> Option<u8> {
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    if rest.is_empty() || rest.starts_with(' ') {
        Some(hashes as u8)
    } else {
        None
    }
}

fn is_rule(trimmed: &str) -> bool {
    let mut chars = trimmed.chars().filter(|c| !c.is_whitespace());
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if !matches!(first, '-' | '*' | '_') {
        return false;
    }
    let mut count = 1;
    for c in chars {
        if c != first {
            return false;
        }
        count += 1;
    }
    count >= 3
}

fn list_marker(trimmed: &str) -> Option<(bool, String)> {
    let first = trimmed.chars().next()?;
    if matches!(first, '-' | '*' | '+') {
        return trimmed[first.len_utf8()..]
            .starts_with(' ')
            .then(|| (false, first.to_string()));
    }
    if first.is_ascii_digit() {
        let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
        let rest = &trimmed[digits.len()..];
        if let Some(after) = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')')) {
            if after.is_empty() || after.starts_with(' ') {
                return Some((true, format!("{digits}.")));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(source: &str) -> Vec<RegionKind> {
        parse_regions(source).into_iter().map(|r| r.kind).collect()
    }

    #[test]
    fn classifies_common_blocks() {
        let source = "# Title\n\nA paragraph.\n- item\n> quote\n---\n```rust\nlet x = 1;\n```";
        let kinds = kinds(source);
        assert_eq!(
            kinds,
            vec![
                RegionKind::Heading(1),
                RegionKind::Blank,
                RegionKind::Paragraph,
                RegionKind::ListItem {
                    ordered: false,
                    marker: "-".into()
                },
                RegionKind::BlockQuote,
                RegionKind::Rule,
                RegionKind::CodeBlock {
                    lang: "rust".into()
                },
            ]
        );
    }

    #[test]
    fn region_ranges_slice_back_to_source() {
        let source = "# Title\n\ntext here\n- one\n- two";
        for region in parse_regions(source) {
            let slice = &source[region.content.clone()];
            assert_eq!(slice, slice.trim_end_matches(['\r']));
        }
    }

    #[test]
    fn fenced_code_spans_multiple_lines() {
        let source = "before\n```\nline1\nline2\n```\nafter";
        let regions = parse_regions(source);
        assert_eq!(regions.len(), 3);
        assert_eq!(
            &source[regions[1].content.clone()],
            "```\nline1\nline2\n```"
        );
    }

    #[test]
    fn blockquote_merges_consecutive_lines() {
        let source = "> a\n> b\nplain";
        let regions = parse_regions(source);
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].kind, RegionKind::BlockQuote);
        assert_eq!(&source[regions[0].content.clone()], "> a\n> b");
    }

    #[test]
    fn ordered_and_unordered_markers() {
        assert_eq!(list_marker("- x"), Some((false, "-".into())));
        assert_eq!(list_marker("2) x"), Some((true, "2.".into())));
        assert_eq!(list_marker("no"), None);
        assert!(heading_level("#### deep").is_some());
        assert_eq!(heading_level("#nospace"), None);
    }
}
