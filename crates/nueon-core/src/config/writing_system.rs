//! Writing system: glyph outlines, phoneme mapping and orthography rules.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Writing direction at the writing-system level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WritingDirection {
    #[default]
    Ltr,
    Rtl,
    Ttb,
}

/// Node kinds: `corner` has free handles, `smooth` has colinear handles,
/// `symmetric` has equal-length colinear handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Corner,
    Smooth,
    Symmetric,
}

/// Fill rule for a contour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillRule {
    Nonzero,
    Evenodd,
}

/// One on-curve point with optional Bezier handles (offsets from the point).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle_in: Option<(f64, f64)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle_out: Option<(f64, f64)>,
    pub kind: NodeKind,
}

/// One closed or open path of nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Contour {
    pub nodes: Vec<Node>,
    pub closed: bool,
    pub fill_rule: FillRule,
}

/// A reusable glyph referenced inside another glyph (TrueType-composite-like).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComponentInstance {
    /// Glyph id of the component.
    pub glyph: String,
    pub dx: f64,
    pub dy: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotation: f64,
}

/// One element of a glyph: a contour or a component instance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutlineElement {
    Contour(Contour),
    Component(ComponentInstance),
}

/// A glyph's vector data, stored one-per-file in `writing/glyphs/<id>.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GlyphOutline {
    pub elements: Vec<OutlineElement>,
    /// Explicit advance width in font units; None derives from bounds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advance: Option<f64>,
    /// Explicit side bearings; None derives from bounds when placed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lsb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rsb: Option<f64>,
}

/// One glyph's identity and mapping, held in `config/writing`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlyphMeta {
    /// Stable id; the outline file is `writing/glyphs/<id>.json`.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Allocated codepoint (PUA), user-overridable.
    pub codepoint: u32,
    /// Phoneme ids this glyph renders (many-to-many).
    #[serde(default)]
    pub phonemes: Vec<String>,
    /// Display order in the glyph grid.
    #[serde(default)]
    pub order: u32,
    /// Navigator group: a phonology category, a user folder, or `radicals`.
    #[serde(default)]
    pub group: String,
}

/// An ordered orthography rule: a grapheme/phoneme sequence becomes a glyph
/// sequence in a context. Reuses the phonology tokenizer and context matcher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrthographyRule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The grapheme/phoneme sequence to match.
    pub from: String,
    /// Glyph ids to emit.
    pub to: Vec<String>,
    /// Context constraints, using the phonology `C V L #` vocabulary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<String>,
}

/// The default units-per-em for a writing system.
fn default_upem() -> u16 {
    1000
}

/// The writing-system config file (`config/writing`), and the part of Profile
/// v3 that travels with it. Outlines are referenced by id, never embedded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WritingConfig {
    pub direction: WritingDirection,
    /// Units per em, fixed at 1000.
    #[serde(default = "default_upem")]
    pub upem: u16,
    /// Metrics guide heights (baseline is 0 by convention; 0 = unset).
    pub x_height: f64,
    pub cap_height: f64,
    pub ascender: f64,
    pub descender: f64,
    /// Ordered glyphs.
    pub glyphs: Vec<GlyphMeta>,
    /// Ordered orthography rules, applied left to right.
    pub rules: Vec<OrthographyRule>,
    /// OpenType feature text (GSUB romanisation -> glyphs).
    pub features: String,
}

impl Default for WritingConfig {
    fn default() -> Self {
        Self {
            direction: WritingDirection::Ltr,
            upem: 1000,
            x_height: 0.0,
            cap_height: 0.0,
            ascender: 0.0,
            descender: 0.0,
            glyphs: Vec::new(),
            rules: Vec::new(),
            features: String::new(),
        }
    }
}

/// Reject an outline whose coordinates are not finite. Returns a description of
/// the first offending value, or `Ok` when the outline is clean.
pub fn validate_outline(outline: &GlyphOutline) -> Result<(), String> {
    for element in &outline.elements {
        match element {
            OutlineElement::Contour(contour) => {
                for node in &contour.nodes {
                    if !node.x.is_finite() || !node.y.is_finite() {
                        return Err("non-finite node coordinate".to_string());
                    }
                    for (hx, hy) in node.handle_in.iter().chain(node.handle_out.iter()) {
                        if !hx.is_finite() || !hy.is_finite() {
                            return Err("non-finite handle coordinate".to_string());
                        }
                    }
                }
            }
            OutlineElement::Component(component) => {
                if !component.dx.is_finite()
                    || !component.dy.is_finite()
                    || !component.scale_x.is_finite()
                    || !component.scale_y.is_finite()
                    || !component.rotation.is_finite()
                {
                    return Err("non-finite component transform".to_string());
                }
            }
        }
    }
    Ok(())
}

/// Validate the component graph: every `ComponentInstance` target resolves and
/// the graph of component references is acyclic. `outlines` is `(glyph id,
/// outline)` for every glyph in the writing system.
pub fn validate_components(outlines: &[(String, &GlyphOutline)]) -> Result<(), String> {
    let index: HashMap<&str, usize> = outlines
        .iter()
        .enumerate()
        .map(|(i, (id, _))| (id.as_str(), i))
        .collect();

    let ids: Vec<&str> = outlines.iter().map(|(id, _)| id.as_str()).collect();
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); outlines.len()];
    for (i, (id, outline)) in outlines.iter().enumerate() {
        for element in &outline.elements {
            if let OutlineElement::Component(component) = element {
                match index.get(component.glyph.as_str()) {
                    Some(&target) => adjacency[i].push(target),
                    None => {
                        return Err(format!(
                            "glyph {id} references missing component {}",
                            component.glyph
                        ))
                    }
                }
            }
        }
    }

    // 0 = unvisited, 1 = on the current stack, 2 = fully explored.
    let mut state = vec![0u8; outlines.len()];
    for start in 0..outlines.len() {
        if state[start] != 0 {
            continue;
        }
        let mut stack = Vec::new();
        visit(start, &adjacency, &mut state, &mut stack, &ids)?;
    }
    Ok(())
}

/// Depth-first search of the component graph, reporting the first cycle found.
fn visit(
    node: usize,
    adjacency: &[Vec<usize>],
    state: &mut [u8],
    stack: &mut Vec<usize>,
    ids: &[&str],
) -> Result<(), String> {
    state[node] = 1;
    stack.push(node);
    for &next in &adjacency[node] {
        match state[next] {
            0 => visit(next, adjacency, state, stack, ids)?,
            1 => {
                let mut path: Vec<&str> = stack.iter().map(|&n| ids[n]).collect();
                path.push(ids[next]);
                return Err(format!("component cycle: {}", path.join(" -> ")));
            }
            _ => {}
        }
    }
    stack.pop();
    state[node] = 2;
    Ok(())
}

/// Format a coordinate for SVG, clamped to a finite, reasonably precise value.
fn fmt_coord(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded == 0.0 {
        "0".to_string()
    } else {
        format!("{rounded}")
    }
}

/// The SVG path `d` data for a glyph's contours. Components are skipped here —
/// expansion is a separate (Rust) operation. `y_flip` mirrors storage's y-up
/// into SVG's y-down.
pub fn path_data(outline: &GlyphOutline, y_flip: bool) -> String {
    let mut d = String::new();
    for element in &outline.elements {
        if let OutlineElement::Contour(contour) = element {
            d.push_str(&contour_path_data(contour, y_flip));
        }
    }
    d
}

fn contour_path_data(contour: &Contour, y_flip: bool) -> String {
    let nodes = &contour.nodes;
    if nodes.is_empty() {
        return String::new();
    }
    let cy = |y: f64| if y_flip { -y } else { y };
    let first = &nodes[0];
    let mut d = format!("M {} {}", fmt_coord(first.x), fmt_coord(cy(first.y)));
    let count = nodes.len();
    for i in 1..count {
        d.push_str(&segment(&nodes[i - 1], &nodes[i], &cy));
    }
    if contour.closed && count > 1 {
        d.push_str(&segment(&nodes[count - 1], &nodes[0], &cy));
    }
    if contour.closed {
        d.push_str(" Z");
    }
    d
}

fn segment(prev: &Node, cur: &Node, cy: &dyn Fn(f64) -> f64) -> String {
    match (&prev.handle_out, &cur.handle_in) {
        (Some(out), Some(in_handle)) => format!(
            " C {} {} {} {} {} {}",
            fmt_coord(prev.x + out.0),
            fmt_coord(cy(prev.y + out.1)),
            fmt_coord(cur.x + in_handle.0),
            fmt_coord(cy(cur.y + in_handle.1)),
            fmt_coord(cur.x),
            fmt_coord(cy(cur.y))
        ),
        _ => format!(" L {} {}", fmt_coord(cur.x), fmt_coord(cy(cur.y))),
    }
}

/// The y-down bounding box of a glyph's contours, or `(0, 0, 0, 0)` when empty.
fn outline_bounds(outline: &GlyphOutline) -> (f64, f64, f64, f64) {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut seen = false;
    for element in &outline.elements {
        if let OutlineElement::Contour(contour) = element {
            for node in &contour.nodes {
                if !node.x.is_finite() || !node.y.is_finite() {
                    continue;
                }
                seen = true;
                min_x = min_x.min(node.x);
                max_x = max_x.max(node.x);
                min_y = min_y.min(-node.y);
                max_y = max_y.max(-node.y);
            }
        }
    }
    if !seen {
        return (0.0, 0.0, 0.0, 0.0);
    }
    (min_x, min_y, max_x - min_x, max_y - min_y)
}

/// A single glyph rendered as an SVG `<symbol>` (y-flipped), reusable by
/// `<use>` in the preview.
pub fn to_svg_symbol(name: &str, outline: &GlyphOutline) -> String {
    let (x, y, width, height) = outline_bounds(outline);
    let d = path_data(outline, true);
    format!("<symbol id=\"{name}\" viewBox=\"{x} {y} {width} {height}\"><path d=\"{d}\"/></symbol>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(x: f64, y: f64) -> Node {
        Node {
            x,
            y,
            handle_in: None,
            handle_out: None,
            kind: NodeKind::Corner,
        }
    }

    fn contour(points: &[(f64, f64)]) -> Contour {
        Contour {
            nodes: points.iter().map(|&(x, y)| node(x, y)).collect(),
            closed: true,
            fill_rule: FillRule::Nonzero,
        }
    }

    fn component(glyph: &str) -> OutlineElement {
        OutlineElement::Component(ComponentInstance {
            glyph: glyph.to_string(),
            dx: 0.0,
            dy: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation: 0.0,
        })
    }

    fn glyph(elements: Vec<OutlineElement>) -> GlyphOutline {
        GlyphOutline {
            elements,
            advance: None,
            lsb: None,
            rsb: None,
        }
    }

    #[test]
    fn component_instance_round_trips() {
        let instance = ComponentInstance {
            glyph: "g-1".into(),
            dx: 10.0,
            dy: -20.0,
            scale_x: 2.0,
            scale_y: -1.0,
            rotation: 0.5,
        };
        let json = serde_json::to_string(&instance).unwrap();
        let back: ComponentInstance = serde_json::from_str(&json).unwrap();
        assert_eq!(back, instance);
    }

    #[test]
    fn outline_element_round_trips_contour_and_component() {
        let contour_element = OutlineElement::Contour(contour(&[(0.0, 0.0), (10.0, 20.0)]));
        let json = serde_json::to_string(&contour_element).unwrap();
        let back: OutlineElement = serde_json::from_str(&json).unwrap();
        assert_eq!(back, contour_element);

        let component_element = component("other");
        let json = serde_json::to_string(&component_element).unwrap();
        let back: OutlineElement = serde_json::from_str(&json).unwrap();
        assert_eq!(back, component_element);
    }

    #[test]
    fn glyph_outline_round_trips_mixed_elements() {
        let outline = glyph(vec![
            OutlineElement::Contour(contour(&[(0.0, 0.0), (100.0, 0.0), (50.0, 80.0)])),
            component("radical-1"),
        ]);
        let json = serde_json::to_string(&outline).unwrap();
        let back: GlyphOutline = serde_json::from_str(&json).unwrap();
        assert_eq!(back, outline);
    }

    #[test]
    fn writing_config_defaults_upem_to_1000() {
        let config: WritingConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config.upem, 1000);
        assert_eq!(config.direction, WritingDirection::Ltr);
        assert!(config.glyphs.is_empty());
    }

    #[test]
    fn writing_config_round_trips() {
        let config = WritingConfig {
            direction: WritingDirection::Rtl,
            upem: 1000,
            x_height: 500.0,
            cap_height: 700.0,
            ascender: 800.0,
            descender: -200.0,
            glyphs: vec![GlyphMeta {
                id: "g-1".into(),
                name: "ka".into(),
                codepoint: 0xE000,
                phonemes: vec!["p-1".into()],
                order: 0,
                group: "consonants".into(),
            }],
            rules: vec![OrthographyRule {
                name: Some("ka".into()),
                from: "ka".into(),
                to: vec!["g-1".into()],
                left: None,
                right: None,
            }],
            features: "feature liga { sub k a by ka; } liga;".into(),
        };
        let json = serde_json::to_string(&config).unwrap();
        let back: WritingConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, config);
    }

    #[test]
    fn validate_rejects_cycle() {
        let a = glyph(vec![component("b")]);
        let b = glyph(vec![component("a")]);
        let outlines = vec![("a".to_string(), &a), ("b".to_string(), &b)];
        let err = validate_components(&outlines).unwrap_err();
        assert!(err.contains("cycle"), "error names the cycle: {err}");
    }

    #[test]
    fn validate_accepts_acyclic_graph() {
        let a = glyph(vec![component("b")]);
        let b = glyph(vec![component("c")]);
        let c = glyph(vec![]);
        let outlines = vec![
            ("a".to_string(), &a),
            ("b".to_string(), &b),
            ("c".to_string(), &c),
        ];
        assert!(validate_components(&outlines).is_ok());
    }

    #[test]
    fn validate_rejects_missing_component() {
        let a = glyph(vec![component("missing")]);
        let outlines = vec![("a".to_string(), &a)];
        let err = validate_components(&outlines).unwrap_err();
        assert!(err.contains("missing"), "error names the target: {err}");
    }

    #[test]
    fn validate_accepts_self_contained_contour() {
        let a = glyph(vec![OutlineElement::Contour(contour(&[
            (0.0, 0.0),
            (10.0, 0.0),
            (10.0, 10.0),
        ]))]);
        let outlines = vec![("a".to_string(), &a)];
        assert!(validate_components(&outlines).is_ok());
    }

    #[test]
    fn svg_path_starts_with_move_and_has_no_nan() {
        let outline = glyph(vec![OutlineElement::Contour(contour(&[
            (0.0, 0.0),
            (100.0, 0.0),
            (100.0, 100.0),
        ]))]);
        let d = path_data(&outline, true);
        assert!(d.starts_with("M"), "path starts with a move: {d}");
        assert!(!d.contains("NaN") && !d.contains("inf"), "clean path: {d}");
    }

    #[test]
    fn svg_symbol_embeds_path_and_viewbox() {
        let outline = glyph(vec![OutlineElement::Contour(contour(&[
            (0.0, 0.0),
            (10.0, 0.0),
        ]))]);
        let svg = to_svg_symbol("glyph-a", &outline);
        assert!(svg.starts_with("<symbol id=\"glyph-a\""), "symbol: {svg}");
        assert!(svg.contains("<path d=\"M"), "path embedded: {svg}");
        assert!(svg.contains("viewBox="), "viewBox present: {svg}");
    }

    #[test]
    fn validate_outline_rejects_nan_coordinates() {
        let outline = glyph(vec![OutlineElement::Contour(contour(&[(0.0, f64::NAN)]))]);
        assert!(validate_outline(&outline).is_err());
    }

    #[test]
    fn validate_outline_accepts_clean_contours() {
        let outline = glyph(vec![OutlineElement::Contour(contour(&[
            (0.0, 0.0),
            (1.0, 2.0),
        ]))]);
        assert!(validate_outline(&outline).is_ok());
    }
}
