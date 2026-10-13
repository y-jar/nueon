//! Cubic glyph contours to TrueType quadratic outlines.

use kurbo::{cubics_to_quadratic_splines, BezPath, CubicBez, Point};
use write_fonts::tables::glyf::{Glyph, SimpleGlyph};

use crate::config::Contour;

/// Maximum deviation, in font units, allowed when converting cubics to quadratics.
const ACCURACY: f64 = 1.0;

/// Reasons a glyph cannot be compiled.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum FontError {
    #[error("glyph {0}: {1}")]
    Glyph(String, String),
    #[error("font: {0}")]
    Font(String),
}

fn point(x: f64, y: f64) -> Point {
    Point::new(x, y)
}

/// One closed `BezPath` per contour, with cubic segments approximated by quadratics.
pub fn contours_to_bezpaths(contours: &[Contour]) -> Result<Vec<BezPath>, String> {
    let mut paths = Vec::new();
    for contour in contours {
        let nodes = &contour.nodes;
        if nodes.len() < 2 {
            continue;
        }
        let count = nodes.len();
        let mut cubics = Vec::with_capacity(count);
        for i in 0..count {
            let a = &nodes[i];
            let b = &nodes[(i + 1) % count];
            let p1 = a
                .handle_out
                .map_or(point(a.x, a.y), |(hx, hy)| point(a.x + hx, a.y + hy));
            let p2 = b
                .handle_in
                .map_or(point(b.x, b.y), |(hx, hy)| point(b.x + hx, b.y + hy));
            cubics.push(CubicBez::new(point(a.x, a.y), p1, p2, point(b.x, b.y)));
        }
        let splines = cubics_to_quadratic_splines(&cubics, ACCURACY)
            .ok_or_else(|| "a curve could not be approximated".to_string())?;
        let mut path = BezPath::new();
        path.move_to(point(nodes[0].x, nodes[0].y));
        for (cubic, spline) in cubics.iter().zip(&splines) {
            let straight = cubic.p1 == cubic.p0 && cubic.p2 == cubic.p3;
            if straight {
                path.line_to(cubic.p3);
                continue;
            }
            for quad in spline.to_quads() {
                path.quad_to(quad.p1, quad.p2);
            }
        }
        path.close_path();
        paths.push(path);
    }
    Ok(paths)
}

/// A simple glyph from flattened contours (an empty glyph when there are none).
pub fn glyph_from_contours(name: &str, contours: &[Contour]) -> Result<Glyph, FontError> {
    let paths =
        contours_to_bezpaths(contours).map_err(|err| FontError::Glyph(name.to_string(), err))?;
    let mut combined = BezPath::new();
    for path in &paths {
        combined.extend(path.elements().iter().copied());
    }
    if combined.elements().is_empty() {
        return Ok(Glyph::Empty);
    }
    SimpleGlyph::from_bezpath(&combined)
        .map(Glyph::Simple)
        .map_err(|err| FontError::Glyph(name.to_string(), format!("{err:?}")))
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

    fn square() -> Contour {
        Contour {
            nodes: vec![
                corner(0.0, 0.0),
                corner(100.0, 0.0),
                corner(100.0, 100.0),
                corner(0.0, 100.0),
            ],
            closed: true,
            fill_rule: FillRule::Nonzero,
        }
    }

    fn circle() -> Contour {
        let k = 0.5522847498307936 * 100.0;
        let node = |x: f64, y: f64, hin: (f64, f64), hout: (f64, f64)| Node {
            x,
            y,
            handle_in: Some(hin),
            handle_out: Some(hout),
            kind: NodeKind::Smooth,
        };
        Contour {
            nodes: vec![
                node(100.0, 0.0, (0.0, -k), (0.0, k)),
                node(0.0, 100.0, (k, 0.0), (-k, 0.0)),
                node(-100.0, 0.0, (0.0, k), (0.0, -k)),
                node(0.0, -100.0, (-k, 0.0), (k, 0.0)),
            ],
            closed: true,
            fill_rule: FillRule::Nonzero,
        }
    }

    #[test]
    fn a_square_stays_four_straight_segments() {
        let paths = contours_to_bezpaths(&[square()]).unwrap();
        assert_eq!(paths.len(), 1);
        let quads = paths[0]
            .elements()
            .iter()
            .filter(|el| matches!(el, kurbo::PathEl::QuadTo(..)))
            .count();
        assert_eq!(quads, 0, "straight edges do not become curves");
    }

    #[test]
    fn a_circle_becomes_quadratics_within_tolerance() {
        let paths = contours_to_bezpaths(&[circle()]).unwrap();
        let quads = paths[0]
            .elements()
            .iter()
            .filter(|el| matches!(el, kurbo::PathEl::QuadTo(..)))
            .count();
        assert!(quads >= 4, "curves are approximated by quadratics: {quads}");
        let bounds = kurbo::Shape::bounding_box(&paths[0]);
        assert!((bounds.max_x() - 100.0).abs() < 2.0, "{bounds:?}");
        assert!((bounds.min_y() + 100.0).abs() < 2.0, "{bounds:?}");
    }

    #[test]
    fn glyphs_build_and_empty_input_is_an_empty_glyph() {
        assert!(matches!(
            glyph_from_contours("sq", &[square()]).unwrap(),
            Glyph::Simple(_)
        ));
        assert!(matches!(
            glyph_from_contours("none", &[]).unwrap(),
            Glyph::Empty
        ));
    }
}
