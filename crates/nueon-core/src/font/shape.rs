//! Shape text against a compiled font with harfrust, so a preview cannot disagree with the export.

use harfrust::{shape, Buffer, Direction as HbDirection, Font, ShapeOptions, ShaperFont};
use serde::Serialize;

use super::compile::FontGlyph;
use super::outline::FontError;

/// Which way a run is laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Ltr,
    Rtl,
}

/// One glyph of a shaped run, in glyph-id order of the compiled font (0 is `.notdef`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShapedGlyph {
    pub id: u32,
    /// Index of the input character this glyph came from.
    pub cluster: u32,
    pub advance: i32,
    pub x_offset: i32,
    pub y_offset: i32,
}

/// A shaped run: the glyphs in visual order and the total advance, in font units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShapedRun {
    pub glyphs: Vec<ShapedGlyph>,
    pub advance: i32,
    pub upem: u16,
}

/// Shape `text` with the font in `bytes`. Characters the font lacks become `.notdef`.
pub fn shape_text(bytes: &[u8], text: &str, direction: Direction) -> Result<ShapedRun, FontError> {
    let font = Font::new(bytes.to_vec(), 0)
        .ok_or_else(|| FontError::Font("the font could not be read for shaping".to_string()))?;
    let shaper = ShaperFont::new(&font);
    let mut buffer = Buffer::new();
    buffer.push_str(text);
    buffer.set_direction(match direction {
        Direction::Ltr => HbDirection::LeftToRight,
        Direction::Rtl => HbDirection::RightToLeft,
    });
    buffer.guess_segment_properties();
    shape(&shaper, &mut buffer, ShapeOptions::new())
        .map_err(|err| FontError::Font(format!("shaping failed: {err:?}")))?;
    let glyphs: Vec<ShapedGlyph> = buffer
        .glyph_infos()
        .iter()
        .zip(buffer.glyph_positions())
        .map(|(info, pos)| ShapedGlyph {
            id: info.glyph_id,
            cluster: info.cluster,
            advance: pos.x_advance,
            x_offset: pos.x_offset,
            y_offset: pos.y_offset,
        })
        .collect();
    let advance = glyphs.iter().map(|g| g.advance).sum();
    Ok(ShapedRun {
        glyphs,
        advance,
        upem: font.units_per_em(),
    })
}

/// The compiled font's glyph names by id: `.notdef`, then each user glyph, in order.
pub fn glyph_names(glyphs: &[FontGlyph]) -> Vec<String> {
    let mut names = vec![".notdef".to_string()];
    names.extend(glyphs.iter().map(|g| g.meta.name.clone()));
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        Contour, FillRule, GlyphMeta, Node, NodeKind, OrthographyRule, Phoneme, PhonemeKind,
    };
    use crate::font::{compile_font, FontGlyph, FontSettings};

    fn corner(x: f64, y: f64) -> Node {
        Node {
            x,
            y,
            handle_in: None,
            handle_out: None,
            kind: NodeKind::Corner,
        }
    }

    fn glyph(id: &str, cp: u32, size: f64, advance: f64) -> FontGlyph {
        FontGlyph {
            meta: GlyphMeta {
                id: id.into(),
                name: id.into(),
                codepoint: cp,
                phonemes: vec![],
                order: 0,
                group: String::new(),
                forms: Default::default(),
            },
            contours: vec![Contour {
                nodes: vec![
                    corner(0.0, 0.0),
                    corner(0.0, size),
                    corner(size, size),
                    corner(size, 0.0),
                ],
                closed: true,
                fill_rule: FillRule::Nonzero,
            }],
            advance: Some(advance),
        }
    }

    fn settings(rules: Vec<OrthographyRule>) -> FontSettings {
        FontSettings {
            family: "T".into(),
            upem: 1000,
            ascender: 800.0,
            descender: -200.0,
            x_height: 500.0,
            cap_height: 700.0,
            rules,
            phonemes: vec![
                Phoneme {
                    id: "k".into(),
                    symbol: "k".into(),
                    kind: PhonemeKind::Consonant,
                },
                Phoneme {
                    id: "a".into(),
                    symbol: "a".into(),
                    kind: PhonemeKind::Vowel,
                },
            ],
        }
    }

    fn rule(from: &str, to: &[&str]) -> OrthographyRule {
        OrthographyRule {
            name: None,
            from: from.into(),
            to: to.iter().map(|s| s.to_string()).collect(),
            left: None,
            right: None,
        }
    }

    fn build(rules: Vec<OrthographyRule>) -> (Vec<u8>, Vec<FontGlyph>) {
        let glyphs = vec![
            glyph("ka", 0xE000, 300.0, 400.0),
            glyph("tu", 0xE001, 200.0, 250.0),
        ];
        let (bytes, _) = compile_font(&settings(rules), &glyphs).unwrap();
        (bytes, glyphs)
    }

    #[test]
    fn shaping_private_use_text_gives_each_glyph_its_own_advance() {
        let (bytes, glyphs) = build(vec![]);
        let run = shape_text(&bytes, "\u{E000}\u{E001}", Direction::Ltr).unwrap();
        assert_eq!(run.glyphs.len(), 2);
        assert_eq!(run.glyphs[0].id, 1);
        assert_eq!(run.glyphs[1].id, 2);
        assert_eq!(run.glyphs[0].advance, 400);
        assert_eq!(run.glyphs[1].advance, 250);
        assert_eq!(run.advance, 650);
        assert_eq!(run.upem, 1000);
        let names = glyph_names(&glyphs);
        assert_eq!(names[1], "ka");
        assert_eq!(names[2], "tu");
    }

    #[test]
    fn the_romanisation_rules_apply_in_the_preview_exactly_as_in_the_font() {
        let (bytes, _) = build(vec![rule("ka", &["ka"]), rule("tu", &["tu"])]);
        let run = shape_text(&bytes, "katu", Direction::Ltr).unwrap();
        let ids: Vec<u32> = run.glyphs.iter().map(|g| g.id).collect();
        assert_eq!(ids, vec![1, 2], "k+a became ka and t+u became tu");
    }

    #[test]
    fn each_shaped_glyph_reports_the_input_character_it_came_from() {
        let (bytes, _) = build(vec![rule("ka", &["ka"])]);
        let run = shape_text(&bytes, "kak", Direction::Ltr).unwrap();
        let clusters: Vec<u32> = run.glyphs.iter().map(|g| g.cluster).collect();
        assert_eq!(clusters[0], 0, "the ligature starts at the first character");
        assert!(clusters[1] >= 2);
    }

    #[test]
    fn right_to_left_text_is_laid_out_in_reverse_visual_order() {
        let (bytes, _) = build(vec![]);
        let ltr = shape_text(&bytes, "\u{E000}\u{E001}", Direction::Ltr).unwrap();
        let rtl = shape_text(&bytes, "\u{E000}\u{E001}", Direction::Rtl).unwrap();
        assert_eq!(
            ltr.glyphs.iter().map(|g| g.id).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(
            rtl.glyphs.iter().map(|g| g.id).collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert_eq!(ltr.advance, rtl.advance);
    }

    #[test]
    fn empty_text_is_an_empty_run_and_garbage_bytes_are_an_error() {
        let (bytes, _) = build(vec![]);
        let run = shape_text(&bytes, "", Direction::Ltr).unwrap();
        assert!(run.glyphs.is_empty());
        assert_eq!(run.advance, 0);
        assert!(shape_text(b"not a font", "a", Direction::Ltr).is_err());
    }

    #[test]
    fn missing_characters_become_notdef_not_an_error() {
        let (bytes, _) = build(vec![]);
        let run = shape_text(&bytes, "\u{E000}Z\u{E001}", Direction::Ltr).unwrap();
        assert_eq!(run.glyphs.len(), 3);
        assert_eq!(run.glyphs[1].id, 0);
    }
}
