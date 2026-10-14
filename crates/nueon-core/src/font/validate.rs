//! Pre-export checks on glyph outlines, modelled on FontForge's Validate.

use kurbo::{flatten, PathEl, Shape};
use serde::Serialize;

use crate::config::{Contour, FillRule};

use super::compile::FontGlyph;
use super::outline::contours_to_bezpaths;

/// How serious an issue is: errors block the export, the rest are advice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// One finding about one glyph.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FontIssue {
    pub glyph: String,
    pub name: String,
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
}

const FLATNESS: f64 = 0.5;
const COORD_LIMIT: f64 = 32767.0;
const MAX_NAME: usize = 31;

fn issue(glyph: &FontGlyph, severity: Severity, code: &'static str, message: String) -> FontIssue {
    FontIssue {
        glyph: glyph.meta.id.clone(),
        name: glyph.meta.name.clone(),
        severity,
        code,
        message,
    }
}

/// Signed area of one contour: positive when it runs counter-clockwise (y up).
fn signed_area(contour: &Contour) -> f64 {
    contours_to_bezpaths(std::slice::from_ref(contour))
        .ok()
        .and_then(|paths| paths.first().map(|path| path.area()))
        .unwrap_or(0.0)
}

/// A contour traced backwards, with its handles swapped to match.
pub fn reverse_contour(contour: &Contour) -> Contour {
    let mut nodes: Vec<_> = contour.nodes.iter().rev().cloned().collect();
    for node in &mut nodes {
        std::mem::swap(&mut node.handle_in, &mut node.handle_out);
    }
    Contour {
        nodes,
        closed: contour.closed,
        fill_rule: contour.fill_rule,
    }
}

/// True when the glyph's largest contour runs counter-clockwise, the wrong way
/// for a TrueType outer contour.
pub fn needs_reversal(contours: &[Contour]) -> bool {
    contours
        .iter()
        .map(signed_area)
        .max_by(|a, b| a.abs().total_cmp(&b.abs()))
        .is_some_and(|area| area > 0.0)
}

/// Outer contours clockwise, as TrueType expects. Every contour is reversed
/// together, which negates all winding numbers and so leaves a nonzero fill
/// (including holes and overlaps) exactly as drawn.
pub fn normalise_winding(contours: &[Contour]) -> Vec<Contour> {
    if needs_reversal(contours) {
        contours.iter().map(reverse_contour).collect()
    } else {
        contours.to_vec()
    }
}

type Segment = ((f64, f64), (f64, f64));

fn flatten_segments(contour: &Contour) -> Vec<Segment> {
    let Ok(paths) = contours_to_bezpaths(std::slice::from_ref(contour)) else {
        return Vec::new();
    };
    let mut points: Vec<(f64, f64)> = Vec::new();
    for path in &paths {
        flatten(path.elements().iter().copied(), FLATNESS, |el| match el {
            PathEl::MoveTo(p) | PathEl::LineTo(p) => points.push((p.x, p.y)),
            _ => {}
        });
    }
    points.dedup();
    if points.len() > 1 && points.first() == points.last() {
        points.pop();
    }
    let count = points.len();
    if count < 3 {
        return Vec::new();
    }
    (0..count)
        .map(|i| (points[i], points[(i + 1) % count]))
        .collect()
}

fn orient(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

fn crosses(a: &Segment, b: &Segment) -> bool {
    const EPS: f64 = 1e-9;
    let d1 = orient(a.0, a.1, b.0);
    let d2 = orient(a.0, a.1, b.1);
    let d3 = orient(b.0, b.1, a.0);
    let d4 = orient(b.0, b.1, a.1);
    ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS))
        && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
}

/// Does a contour cross itself? Neighbouring segments are skipped; they share a point.
pub fn self_intersects(contour: &Contour) -> bool {
    let segments = flatten_segments(contour);
    let count = segments.len();
    for i in 0..count {
        for j in (i + 2)..count {
            if i == 0 && j == count - 1 {
                continue;
            }
            if crosses(&segments[i], &segments[j]) {
                return true;
            }
        }
    }
    false
}

/// `[A-Za-z0-9._]`, at most 31 characters, not starting with a digit.
pub fn valid_glyph_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

fn fractional(contours: &[Contour]) -> usize {
    let off = |v: f64| (v - v.round()).abs() > 0.01;
    contours
        .iter()
        .flat_map(|c| &c.nodes)
        .filter(|n| off(n.x) || off(n.y))
        .count()
}

/// Check every glyph; the result is empty when the system is clean.
pub fn validate_glyphs(glyphs: &[FontGlyph]) -> Vec<FontIssue> {
    let mut issues = Vec::new();

    if glyphs.is_empty() {
        return issues;
    }

    for (i, glyph) in glyphs.iter().enumerate() {
        for other in &glyphs[i + 1..] {
            if other.meta.codepoint == glyph.meta.codepoint {
                issues.push(issue(
                    other,
                    Severity::Error,
                    "duplicate-codepoint",
                    format!(
                        "U+{:X} is also used by {}",
                        other.meta.codepoint, glyph.meta.name
                    ),
                ));
            }
            if !glyph.meta.name.is_empty() && other.meta.name == glyph.meta.name {
                issues.push(issue(
                    other,
                    Severity::Warning,
                    "duplicate-name",
                    format!(
                        "the name \"{}\" is shared with another glyph",
                        other.meta.name
                    ),
                ));
            }
        }
    }

    for glyph in glyphs {
        if char::from_u32(glyph.meta.codepoint).is_none() {
            issues.push(issue(
                glyph,
                Severity::Error,
                "bad-codepoint",
                format!("U+{:X} is not a valid codepoint", glyph.meta.codepoint),
            ));
        }
        if !valid_glyph_name(&glyph.meta.name) {
            issues.push(issue(
                glyph,
                Severity::Warning,
                "bad-name",
                format!(
                    "\"{}\" is not a valid font glyph name (letters, digits, . and _; at most {MAX_NAME}; no leading digit)",
                    glyph.meta.name
                ),
            ));
        }

        let drawn: Vec<&Contour> = glyph.contours.iter().collect();
        if drawn.is_empty() {
            issues.push(issue(
                glyph,
                Severity::Warning,
                "empty",
                "has no outline".to_string(),
            ));
            continue;
        }

        let beyond = glyph
            .contours
            .iter()
            .flat_map(|c| &c.nodes)
            .any(|n| n.x.abs() > COORD_LIMIT || n.y.abs() > COORD_LIMIT);
        if beyond {
            issues.push(issue(
                glyph,
                Severity::Error,
                "out-of-range",
                format!("a point lies beyond +/-{COORD_LIMIT}, the TrueType coordinate limit"),
            ));
        }

        let open = glyph.contours.iter().filter(|c| !c.closed).count();
        if open > 0 {
            issues.push(issue(
                glyph,
                Severity::Warning,
                "open-contour",
                format!("{open} open contour(s) will be closed with a straight line"),
            ));
        }
        let tiny = glyph.contours.iter().filter(|c| c.nodes.len() < 3).count();
        if tiny > 0 {
            issues.push(issue(
                glyph,
                Severity::Warning,
                "degenerate-contour",
                format!("{tiny} contour(s) have fewer than 3 points and draw nothing"),
            ));
        }
        let crossing = glyph.contours.iter().filter(|c| self_intersects(c)).count();
        if crossing > 0 {
            issues.push(issue(
                glyph,
                Severity::Warning,
                "self-intersection",
                format!("{crossing} contour(s) cross themselves"),
            ));
        }
        if glyph
            .contours
            .iter()
            .any(|c| c.fill_rule == FillRule::Evenodd)
        {
            issues.push(issue(
                glyph,
                Severity::Warning,
                "even-odd",
                "even-odd fill is not supported in fonts; contours are filled non-zero".to_string(),
            ));
        }
        if needs_reversal(&glyph.contours) {
            issues.push(issue(
                glyph,
                Severity::Info,
                "winding",
                "outer contour runs counter-clockwise; it is reversed on export".to_string(),
            ));
        }
        let rounded = fractional(&glyph.contours);
        if rounded > 0 {
            issues.push(issue(
                glyph,
                Severity::Info,
                "rounding",
                format!("{rounded} point(s) sit off the integer grid and are rounded on export"),
            ));
        }
    }
    issues
}

/// True when any issue is serious enough to stop the export.
pub fn blocks_export(issues: &[FontIssue]) -> bool {
    issues.iter().any(|i| i.severity == Severity::Error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{GlyphMeta, Node, NodeKind};

    fn corner(x: f64, y: f64) -> Node {
        Node {
            x,
            y,
            handle_in: None,
            handle_out: None,
            kind: NodeKind::Corner,
        }
    }

    fn poly(points: &[(f64, f64)], closed: bool) -> Contour {
        Contour {
            nodes: points.iter().map(|&(x, y)| corner(x, y)).collect(),
            closed,
            fill_rule: FillRule::Nonzero,
        }
    }

    fn ccw_square() -> Contour {
        poly(
            &[(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)],
            true,
        )
    }

    fn cw_square() -> Contour {
        poly(
            &[(0.0, 0.0), (0.0, 100.0), (100.0, 100.0), (100.0, 0.0)],
            true,
        )
    }

    fn glyph(id: &str, name: &str, codepoint: u32, contours: Vec<Contour>) -> FontGlyph {
        FontGlyph {
            meta: GlyphMeta {
                id: id.to_string(),
                name: name.to_string(),
                codepoint,
                phonemes: vec![],
                order: 0,
                group: String::new(),
                forms: Default::default(),
            },
            contours,
            advance: None,
        }
    }

    fn codes(issues: &[FontIssue]) -> Vec<&'static str> {
        issues.iter().map(|i| i.code).collect()
    }

    #[test]
    fn a_clean_glyph_has_no_issues() {
        let issues = validate_glyphs(&[glyph("a", "a", 0xE000, vec![cw_square()])]);
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn counter_clockwise_is_reported_and_reversed_without_changing_the_fill() {
        assert!(needs_reversal(&[ccw_square()]));
        assert!(!needs_reversal(&[cw_square()]));
        let fixed = normalise_winding(&[ccw_square()]);
        assert!(!needs_reversal(&fixed));
        assert_eq!(fixed[0].nodes.len(), 4);
        let area = signed_area(&fixed[0]);
        assert!((area + 10000.0).abs() < 1e-6, "{area}");

        let issues = validate_glyphs(&[glyph("a", "a", 0xE000, vec![ccw_square()])]);
        assert_eq!(codes(&issues), vec!["winding"]);
        assert_eq!(issues[0].severity, Severity::Info);
    }

    #[test]
    fn reversal_moves_every_contour_together_so_holes_stay_holes() {
        let outer = ccw_square();
        let hole = poly(
            &[(25.0, 25.0), (25.0, 75.0), (75.0, 75.0), (75.0, 25.0)],
            true,
        );
        let fixed = normalise_winding(&[outer.clone(), hole.clone()]);
        assert!(signed_area(&fixed[0]) < 0.0, "outer is clockwise");
        assert!(
            signed_area(&fixed[1]) > 0.0,
            "the hole keeps opposing the outer"
        );
    }

    #[test]
    fn reversing_swaps_handles_so_curves_keep_their_shape() {
        let mut contour = cw_square();
        contour.nodes[0].handle_out = Some((10.0, 0.0));
        contour.nodes[1].handle_in = Some((0.0, 10.0));
        let reversed = reverse_contour(&contour);
        assert_eq!(reversed.nodes[3].handle_in, Some((10.0, 0.0)));
        assert_eq!(reversed.nodes[2].handle_out, Some((0.0, 10.0)));
        assert_eq!(reverse_contour(&reversed), contour);
    }

    #[test]
    fn open_degenerate_and_even_odd_contours_are_flagged() {
        let mut odd = cw_square();
        odd.fill_rule = FillRule::Evenodd;
        let issues = validate_glyphs(&[glyph(
            "a",
            "a",
            0xE000,
            vec![
                poly(&[(0.0, 0.0), (50.0, 0.0), (50.0, 50.0)], false),
                poly(&[(0.0, 0.0), (10.0, 10.0)], true),
                odd,
            ],
        )]);
        let found = codes(&issues);
        assert!(found.contains(&"open-contour"), "{found:?}");
        assert!(found.contains(&"degenerate-contour"), "{found:?}");
        assert!(found.contains(&"even-odd"), "{found:?}");
        assert!(!blocks_export(&issues));
    }

    #[test]
    fn a_bow_tie_crosses_itself_and_a_square_does_not() {
        let bow = poly(
            &[(0.0, 0.0), (100.0, 100.0), (100.0, 0.0), (0.0, 100.0)],
            true,
        );
        assert!(self_intersects(&bow));
        assert!(!self_intersects(&cw_square()));
        assert!(!self_intersects(&ccw_square()));
        let issues = validate_glyphs(&[glyph("a", "a", 0xE000, vec![bow])]);
        assert!(codes(&issues).contains(&"self-intersection"));
    }

    #[test]
    fn overlapping_separate_contours_are_not_self_intersection() {
        let other = poly(
            &[(50.0, 50.0), (50.0, 150.0), (150.0, 150.0), (150.0, 50.0)],
            true,
        );
        let issues = validate_glyphs(&[glyph("a", "a", 0xE000, vec![cw_square(), other])]);
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn a_smooth_circle_is_not_flagged_as_crossing() {
        let k = 0.5522847498307936 * 100.0;
        let node = |x: f64, y: f64, hin: (f64, f64), hout: (f64, f64)| Node {
            x,
            y,
            handle_in: Some(hin),
            handle_out: Some(hout),
            kind: NodeKind::Smooth,
        };
        let circle = Contour {
            nodes: vec![
                node(100.0, 0.0, (0.0, -k), (0.0, k)),
                node(0.0, 100.0, (k, 0.0), (-k, 0.0)),
                node(-100.0, 0.0, (0.0, k), (0.0, -k)),
                node(0.0, -100.0, (-k, 0.0), (k, 0.0)),
            ],
            closed: true,
            fill_rule: FillRule::Nonzero,
        };
        assert!(!self_intersects(&circle));
    }

    #[test]
    fn names_follow_font_rules() {
        assert!(valid_glyph_name("a"));
        assert!(valid_glyph_name("uni_E000.alt"));
        assert!(!valid_glyph_name(""));
        assert!(!valid_glyph_name("9lives"));
        assert!(!valid_glyph_name("has space"));
        assert!(!valid_glyph_name("naïve"));
        assert!(!valid_glyph_name(&"x".repeat(32)));
        assert!(valid_glyph_name(&"x".repeat(31)));
    }

    #[test]
    fn duplicates_empty_and_fractional_points_are_reported() {
        let mut shifted = cw_square();
        shifted.nodes[0].x = 0.4;
        let issues = validate_glyphs(&[
            glyph("a", "same", 0xE000, vec![shifted]),
            glyph("b", "same", 0xE000, vec![]),
        ]);
        let found = codes(&issues);
        assert!(found.contains(&"duplicate-codepoint"), "{found:?}");
        assert!(found.contains(&"duplicate-name"), "{found:?}");
        assert!(found.contains(&"empty"), "{found:?}");
        assert!(found.contains(&"rounding"), "{found:?}");
        assert!(blocks_export(&issues));
        let dup = issues
            .iter()
            .find(|i| i.code == "duplicate-codepoint")
            .unwrap();
        assert_eq!(dup.glyph, "b");
    }

    #[test]
    fn out_of_range_points_block_the_export() {
        let far = poly(&[(0.0, 0.0), (40000.0, 0.0), (40000.0, 10.0)], true);
        let issues = validate_glyphs(&[glyph("a", "a", 0xE000, vec![far])]);
        assert!(codes(&issues).contains(&"out-of-range"));
        assert!(blocks_export(&issues));
    }
}
