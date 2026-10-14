//! Compile a writing system into a TrueType font file.

use std::collections::BTreeSet;

use write_fonts::tables::cmap::Cmap;
use write_fonts::tables::glyf::{GlyfLocaBuilder, Glyph};
use write_fonts::tables::head::{Flags as HeadFlags, Head, MacStyle};
use write_fonts::tables::hhea::Hhea;
use write_fonts::tables::hmtx::{Hmtx, LongMetric};
use write_fonts::tables::maxp::Maxp;
use write_fonts::tables::name::{Name, NameRecord};
use write_fonts::tables::os2::{Os2, SelectionFlags};
use write_fonts::tables::post::Post;
use write_fonts::types::{FWord, Fixed, GlyphId, LongDateTime, NameId, Tag, UfWord};
use write_fonts::FontBuilder;

use crate::config::{Contour, GlyphMeta, OrthographyRule, Phoneme};

use super::layout::{plan_layout, SPACE_ADVANCE};
use super::outline::{glyph_from_contours, FontError};
use super::validate::normalise_winding;

/// One glyph ready to compile: its metadata, flattened contours and metrics.
#[derive(Debug, Clone)]
pub struct FontGlyph {
    pub meta: GlyphMeta,
    pub contours: Vec<Contour>,
    pub advance: Option<f64>,
}

/// Font-wide settings.
#[derive(Debug, Clone)]
pub struct FontSettings {
    pub family: String,
    pub upem: u16,
    pub ascender: f64,
    pub descender: f64,
    pub x_height: f64,
    pub cap_height: f64,
    /// Orthography rules compiled into GSUB, so typing the romanisation renders the script.
    pub rules: Vec<OrthographyRule>,
    /// The inventory, used to resolve `C`, `V` and `L` in rule contexts.
    pub phonemes: Vec<Phoneme>,
}

/// What was written, for the caller's report and for validation.
#[derive(Debug, Clone, PartialEq)]
pub struct FontReport {
    pub glyphs: usize,
    pub mapped: usize,
    pub bytes: usize,
    /// Hidden glyphs added so the rules' letters can be typed.
    pub source_glyphs: usize,
    /// Lookups written to GSUB (zero when there are no usable rules).
    pub lookups: usize,
}

const DEFAULT_ADVANCE: u16 = 600;

fn clamp_i16(value: f64) -> i16 {
    value.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

fn clamp_u16(value: f64) -> u16 {
    value.round().clamp(0.0, u16::MAX as f64) as u16
}

fn name_record(id: NameId, value: &str) -> NameRecord {
    NameRecord::new(3, 1, 0x409, id, value.to_string().into())
}

fn bounds(contours: &[Contour]) -> Option<(f64, f64, f64, f64)> {
    let mut found = None;
    for node in contours.iter().flat_map(|c| &c.nodes) {
        let (min_x, min_y, max_x, max_y) = found.unwrap_or((node.x, node.y, node.x, node.y));
        found = Some((
            min_x.min(node.x),
            min_y.min(node.y),
            max_x.max(node.x),
            max_y.max(node.y),
        ));
    }
    found
}

/// The characters a glyph is reachable by: its private-use codepoint.
fn codepoint(meta: &GlyphMeta) -> Result<char, FontError> {
    char::from_u32(meta.codepoint).ok_or_else(|| {
        FontError::Glyph(
            meta.name.clone(),
            format!("U+{:X} is not a valid codepoint", meta.codepoint),
        )
    })
}

/// Compile glyphs into a TrueType font. Glyph 0 is the required `.notdef`.
pub fn compile_font(
    settings: &FontSettings,
    glyphs: &[FontGlyph],
) -> Result<(Vec<u8>, FontReport), FontError> {
    if glyphs.is_empty() {
        return Err(FontError::Font(
            "the writing system has no glyphs".to_string(),
        ));
    }
    let mut seen = BTreeSet::new();
    for glyph in glyphs {
        if !seen.insert(glyph.meta.codepoint) {
            return Err(FontError::Glyph(
                glyph.meta.name.clone(),
                format!("U+{:X} is used by another glyph", glyph.meta.codepoint),
            ));
        }
    }

    let mut builder = GlyfLocaBuilder::new();
    let mut metrics: Vec<LongMetric> = Vec::new();
    let mut mappings: Vec<(char, GlyphId)> = Vec::new();
    let mut max_points = 0u16;
    let mut max_contours = 0u16;
    let (mut x_min, mut y_min, mut x_max, mut y_max) = (0i16, 0i16, 0i16, 0i16);
    let mut first_bounds = true;

    let add = |builder: &mut GlyfLocaBuilder, glyph: &Glyph| -> Result<(), FontError> {
        builder
            .add_glyph(glyph)
            .map(|_| ())
            .map_err(|err| FontError::Font(err.to_string()))
    };

    // .notdef: an empty glyph with a default advance.
    add(&mut builder, &Glyph::Empty)?;
    metrics.push(LongMetric {
        advance: DEFAULT_ADVANCE,
        side_bearing: 0,
    });

    for (index, glyph) in glyphs.iter().enumerate() {
        let oriented = normalise_winding(&glyph.contours);
        let compiled = glyph_from_contours(&glyph.meta.name, &oriented)?;
        if let Glyph::Simple(simple) = &compiled {
            max_contours = max_contours.max(simple.contours.len() as u16);
            let points: usize = simple.contours.iter().map(|c| c.len()).sum();
            max_points = max_points.max(points.min(u16::MAX as usize) as u16);
        }
        add(&mut builder, &compiled)?;

        let ink = bounds(&glyph.contours);
        let lsb = ink.map_or(0, |b| clamp_i16(b.0));
        if let Some((a, b, c, d)) = ink {
            if first_bounds {
                (x_min, y_min, x_max, y_max) =
                    (clamp_i16(a), clamp_i16(b), clamp_i16(c), clamp_i16(d));
                first_bounds = false;
            } else {
                x_min = x_min.min(clamp_i16(a));
                y_min = y_min.min(clamp_i16(b));
                x_max = x_max.max(clamp_i16(c));
                y_max = y_max.max(clamp_i16(d));
            }
        }
        let advance = glyph
            .advance
            .map(clamp_u16)
            .or_else(|| ink.map(|b| clamp_u16(b.2 + 50.0)))
            .unwrap_or(DEFAULT_ADVANCE);
        metrics.push(LongMetric {
            advance,
            side_bearing: lsb,
        });
        mappings.push((codepoint(&glyph.meta)?, GlyphId::new(index as u32 + 1)));
    }

    let (layout, _) = plan_layout(glyphs, &settings.rules, &settings.phonemes);
    for (at, source) in layout.sources.iter().enumerate() {
        add(&mut builder, &Glyph::Empty)?;
        metrics.push(LongMetric {
            advance: if *source == ' ' { SPACE_ADVANCE } else { 0 },
            side_bearing: 0,
        });
        mappings.push((*source, GlyphId::new((glyphs.len() + 1 + at) as u32)));
    }

    let (glyf, loca, loca_format) = builder.build();
    let num_glyphs = (glyphs.len() + layout.sources.len()) as u16 + 1;
    let advance_max = metrics.iter().map(|m| m.advance).max().unwrap_or(0);
    let min_lsb = metrics.iter().map(|m| m.side_bearing).min().unwrap_or(0);

    let head = Head {
        font_revision: Fixed::from_f64(1.0),
        flags: HeadFlags::BASELINE_AT_Y_0 | HeadFlags::LSB_AT_X_0,
        units_per_em: settings.upem,
        created: LongDateTime::new(0),
        modified: LongDateTime::new(0),
        x_min,
        y_min,
        x_max,
        y_max,
        mac_style: MacStyle::empty(),
        lowest_rec_ppem: 8,
        index_to_loc_format: match loca_format {
            write_fonts::tables::loca::LocaFormat::Short => 0,
            write_fonts::tables::loca::LocaFormat::Long => 1,
        },
        ..Default::default()
    };
    let ascender = clamp_i16(settings.ascender);
    let descender = clamp_i16(settings.descender);
    let hhea = Hhea {
        ascender: FWord::new(ascender),
        descender: FWord::new(descender),
        line_gap: FWord::new(0),
        advance_width_max: UfWord::new(advance_max),
        min_left_side_bearing: FWord::new(min_lsb),
        min_right_side_bearing: FWord::new(0),
        x_max_extent: FWord::new(x_max),
        caret_slope_rise: 1,
        number_of_h_metrics: metrics.len() as u16,
        ..Default::default()
    };
    let hmtx = Hmtx {
        h_metrics: metrics,
        left_side_bearings: Vec::new(),
    };
    let maxp = Maxp {
        num_glyphs,
        max_points: Some(max_points),
        max_contours: Some(max_contours),
        max_composite_points: Some(0),
        max_composite_contours: Some(0),
        max_zones: Some(1),
        max_twilight_points: Some(0),
        max_storage: Some(0),
        max_function_defs: Some(0),
        max_instruction_defs: Some(0),
        max_stack_elements: Some(0),
        max_size_of_instructions: Some(0),
        max_component_elements: Some(0),
        max_component_depth: Some(0),
    };
    let first = mappings
        .iter()
        .map(|(c, _)| *c as u32)
        .min()
        .unwrap_or(0xE000);
    let last = mappings
        .iter()
        .map(|(c, _)| *c as u32)
        .max()
        .unwrap_or(0xE000);
    let os2 = Os2 {
        x_avg_char_width: 500,
        us_weight_class: 400,
        us_width_class: 5,
        fs_selection: SelectionFlags::REGULAR,
        us_first_char_index: first.min(0xFFFF) as u16,
        us_last_char_index: last.min(0xFFFF) as u16,
        s_typo_ascender: ascender,
        s_typo_descender: descender,
        s_typo_line_gap: 0,
        us_win_ascent: clamp_u16(settings.ascender.max(0.0)),
        us_win_descent: clamp_u16(settings.descender.min(0.0).abs()),
        ul_code_page_range_1: Some(1),
        ul_code_page_range_2: Some(0),
        sx_height: Some(clamp_i16(settings.x_height)),
        s_cap_height: Some(clamp_i16(settings.cap_height)),
        us_default_char: Some(0),
        us_break_char: Some(0),
        us_max_context: Some(layout.max_context.max(1)),
        ach_vend_id: Tag::new(b"NUEN"),
        ..Default::default()
    };
    let post = Post {
        version: write_fonts::types::Version16Dot16::VERSION_3_0,
        ..Default::default()
    };
    let family = if settings.family.trim().is_empty() {
        "Nueon Script"
    } else {
        settings.family.trim()
    };
    let name = Name::new(vec![
        name_record(NameId::FAMILY_NAME, family),
        name_record(NameId::SUBFAMILY_NAME, "Regular"),
        name_record(NameId::UNIQUE_ID, &format!("{family} 1.0")),
        name_record(NameId::FULL_NAME, family),
        name_record(NameId::VERSION_STRING, "Version 1.0"),
        name_record(NameId::POSTSCRIPT_NAME, &family.replace(' ', "")),
    ]);
    let cmap = Cmap::from_mappings(mappings.iter().copied())
        .map_err(|err| FontError::Font(err.to_string()))?;

    let mut font = FontBuilder::new();
    let tables = font
        .add_table(&head)
        .and_then(|b| b.add_table(&hhea))
        .and_then(|b| b.add_table(&maxp))
        .and_then(|b| b.add_table(&os2))
        .and_then(|b| b.add_table(&hmtx))
        .and_then(|b| b.add_table(&cmap))
        .and_then(|b| b.add_table(&glyf))
        .and_then(|b| b.add_table(&loca))
        .and_then(|b| b.add_table(&name))
        .and_then(|b| b.add_table(&post));
    tables.map_err(|err| FontError::Font(err.to_string()))?;
    let mut lookups = 0;
    if let Some(gsub) = &layout.gsub {
        lookups = gsub.lookup_list.lookups.len();
        font.add_table(gsub)
            .map_err(|err| FontError::Font(err.to_string()))?;
    }
    let bytes = font.build();
    let report = FontReport {
        glyphs: glyphs.len(),
        mapped: mappings.len(),
        bytes: bytes.len(),
        source_glyphs: layout.sources.len(),
        lookups,
    };
    Ok((bytes, report))
}

/// What reading a compiled font back found.
#[derive(Debug, Clone, PartialEq)]
pub struct FontCheck {
    pub num_glyphs: u16,
    pub units_per_em: u16,
    pub mapped: Vec<(u32, u32)>,
    pub advances: Vec<u16>,
    /// Number of GSUB lookups, zero when the font has no GSUB table.
    pub lookups: usize,
}

/// Parse a font with `read-fonts` and report what it contains, so an export
/// can be verified before it is written to disk.
pub fn read_back(bytes: &[u8]) -> Result<FontCheck, FontError> {
    use read_fonts::{FontRef, TableProvider};

    let font = FontRef::new(bytes).map_err(|err| FontError::Font(err.to_string()))?;
    let head = font
        .head()
        .map_err(|err| FontError::Font(err.to_string()))?;
    let maxp = font
        .maxp()
        .map_err(|err| FontError::Font(err.to_string()))?;
    let hmtx = font
        .hmtx()
        .map_err(|err| FontError::Font(err.to_string()))?;
    let cmap = font
        .cmap()
        .map_err(|err| FontError::Font(err.to_string()))?;
    font.loca(None)
        .map_err(|err| FontError::Font(err.to_string()))?;
    font.glyf()
        .map_err(|err| FontError::Font(err.to_string()))?;
    let mut mapped = Vec::new();
    for record in cmap.encoding_records() {
        let subtable = record
            .subtable(cmap.offset_data())
            .map_err(|err| FontError::Font(err.to_string()))?;
        for (codepoint, glyph) in subtable.iter() {
            mapped.push((codepoint, glyph.to_u32()));
        }
    }
    // Format 4 ends with a 0xFFFF -> .notdef sentinel; it is not a real mapping.
    mapped.retain(|&(codepoint, glyph)| !(codepoint == 0xFFFF && glyph == 0));
    mapped.sort();
    mapped.dedup();
    let lookups = match font.gsub() {
        Ok(gsub) => gsub
            .lookup_list()
            .map_err(|err| FontError::Font(err.to_string()))?
            .lookup_count() as usize,
        Err(_) => 0,
    };
    Ok(FontCheck {
        num_glyphs: maxp.num_glyphs(),
        units_per_em: head.units_per_em(),
        mapped,
        advances: hmtx.h_metrics().iter().map(|m| m.advance()).collect(),
        lookups,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{FillRule, Node, NodeKind};

    fn corner(x: f64, y: f64) -> Node {
        Node {
            x,
            y,
            handle_in: None,
            handle_out: None,
            kind: NodeKind::Corner,
        }
    }

    fn square(size: f64) -> Vec<Contour> {
        vec![Contour {
            nodes: vec![
                corner(0.0, 0.0),
                corner(size, 0.0),
                corner(size, size),
                corner(0.0, size),
            ],
            closed: true,
            fill_rule: FillRule::Nonzero,
        }]
    }

    fn glyph(
        name: &str,
        codepoint: u32,
        contours: Vec<Contour>,
        advance: Option<f64>,
    ) -> FontGlyph {
        FontGlyph {
            meta: GlyphMeta {
                id: name.to_string(),
                name: name.to_string(),
                codepoint,
                phonemes: vec![],
                order: 0,
                group: String::new(),
            },
            contours,
            advance,
        }
    }

    fn settings() -> FontSettings {
        FontSettings {
            family: "Test Script".to_string(),
            upem: 1000,
            ascender: 800.0,
            descender: -200.0,
            x_height: 500.0,
            cap_height: 700.0,
            rules: vec![],
            phonemes: vec![],
        }
    }

    #[test]
    fn a_compiled_font_reads_back_with_its_glyphs_and_codepoints() {
        let glyphs = vec![
            glyph("ka", 0xE000, square(400.0), Some(500.0)),
            glyph("sa", 0xE001, square(300.0), None),
        ];
        let (bytes, report) = compile_font(&settings(), &glyphs).unwrap();
        assert_eq!(report.glyphs, 2);
        assert_eq!(report.mapped, 2);
        assert_eq!(report.bytes, bytes.len());

        let check = read_back(&bytes).unwrap();
        assert_eq!(check.num_glyphs, 3, "two glyphs plus .notdef");
        assert_eq!(check.units_per_em, 1000);
        assert_eq!(check.mapped, vec![(0xE000, 1), (0xE001, 2)]);
        assert_eq!(check.advances[1], 500, "explicit advance is kept");
        assert_eq!(
            check.advances[2], 350,
            "derived from ink bounds plus margin"
        );
    }

    #[test]
    fn an_empty_glyph_still_gets_a_slot_and_a_codepoint() {
        let glyphs = vec![glyph("space", 0xE010, vec![], Some(300.0))];
        let (bytes, _) = compile_font(&settings(), &glyphs).unwrap();
        let check = read_back(&bytes).unwrap();
        assert_eq!(check.mapped, vec![(0xE010, 1)]);
        assert_eq!(check.advances[1], 300);
    }

    #[test]
    fn duplicate_codepoints_are_rejected_before_compiling() {
        let glyphs = vec![
            glyph("a", 0xE000, square(100.0), None),
            glyph("b", 0xE000, square(100.0), None),
        ];
        let err = compile_font(&settings(), &glyphs).unwrap_err();
        assert!(err.to_string().contains("used by another glyph"), "{err}");
    }

    #[test]
    fn no_glyphs_is_an_error_and_garbage_does_not_read_back() {
        assert!(compile_font(&settings(), &[]).is_err());
        assert!(read_back(b"not a font").is_err());
    }

    fn compiled_area(bytes: &[u8], gid: u32) -> f64 {
        use read_fonts::tables::glyf::Glyph as Read;
        use read_fonts::{FontRef, TableProvider};
        let font = FontRef::new(bytes).unwrap();
        let glyf = font.glyf().unwrap();
        let loca = font.loca(None).unwrap();
        let Some(Read::Simple(simple)) = loca.get_glyf(GlyphId::new(gid), &glyf).unwrap() else {
            panic!("glyph {gid} is not a simple glyph");
        };
        let points: Vec<(f64, f64)> = simple
            .points()
            .map(|p| (f64::from(p.x), f64::from(p.y)))
            .collect();
        let mut area = 0.0;
        for i in 0..points.len() {
            let (x1, y1) = points[i];
            let (x2, y2) = points[(i + 1) % points.len()];
            area += x1 * y2 - x2 * y1;
        }
        area / 2.0
    }

    #[test]
    fn counter_clockwise_outlines_are_written_clockwise() {
        let drawn = square(400.0);
        assert!(super::super::validate::needs_reversal(&drawn));
        let (bytes, _) = compile_font(&settings(), &[glyph("a", 0xE000, drawn, None)]).unwrap();
        let area = compiled_area(&bytes, 1);
        assert!(
            (area + 160_000.0).abs() < 1.0,
            "clockwise, same size: {area}"
        );
    }

    #[test]
    fn clockwise_outlines_are_left_alone() {
        let drawn = vec![Contour {
            nodes: vec![
                corner(0.0, 0.0),
                corner(0.0, 400.0),
                corner(400.0, 400.0),
                corner(400.0, 0.0),
            ],
            closed: true,
            fill_rule: FillRule::Nonzero,
        }];
        let (bytes, _) = compile_font(&settings(), &[glyph("a", 0xE000, drawn, None)]).unwrap();
        let area = compiled_area(&bytes, 1);
        assert!((area + 160_000.0).abs() < 1.0, "{area}");
    }

    #[test]
    fn curved_glyphs_compile() {
        let k = 0.5522847498307936 * 100.0;
        let node = |x: f64, y: f64, hin: (f64, f64), hout: (f64, f64)| Node {
            x,
            y,
            handle_in: Some(hin),
            handle_out: Some(hout),
            kind: NodeKind::Smooth,
        };
        let circle = vec![Contour {
            nodes: vec![
                node(100.0, 0.0, (0.0, -k), (0.0, k)),
                node(0.0, 100.0, (k, 0.0), (-k, 0.0)),
                node(-100.0, 0.0, (0.0, k), (0.0, -k)),
                node(0.0, -100.0, (-k, 0.0), (k, 0.0)),
            ],
            closed: true,
            fill_rule: FillRule::Nonzero,
        }];
        let (bytes, _) = compile_font(&settings(), &[glyph("o", 0xE000, circle, None)]).unwrap();
        assert_eq!(read_back(&bytes).unwrap().num_glyphs, 2);
    }
}
