//! Pathfinder boolean operations over glyph contours.
//!
//! Converts [`Contour`]s to `flo_curves` cubic-bezier paths, applies a boolean
//! operation, and converts the result back — preserving cubic curves rather
//! than flattening to polygons.

use flo_curves::bezier::path::{path_combine, PathCombine, SimpleBezierPath};
use flo_curves::Coord2;

use crate::config::{Contour, FillRule, Node, NodeKind};

/// The four pathfinder booleans.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BooleanOp {
    /// Merge the shapes into one outline.
    Union,
    /// Subtract every shape after the first from the first.
    Difference,
    /// Keep only the area common to every shape.
    Intersect,
    /// Union minus intersection (exclusive-or of the filled areas).
    Exclude,
}

/// Intersection accuracy for `flo_curves`, in font units.
const ACCURACY: f64 = 0.1;

fn contour_to_path(contour: &Contour) -> SimpleBezierPath {
    let nodes = &contour.nodes;
    if nodes.is_empty() {
        return (Coord2(0.0, 0.0), Vec::new());
    }
    let start = Coord2(nodes[0].x, nodes[0].y);
    let n = nodes.len();
    let segments = if contour.closed && n > 1 {
        n
    } else {
        n.saturating_sub(1)
    };
    let mut points = Vec::with_capacity(segments);
    for i in 0..segments {
        let cur = &nodes[i];
        let next = &nodes[(i + 1) % n];
        let cp1 = cur.handle_out.map_or(Coord2(cur.x, cur.y), |(hx, hy)| {
            Coord2(cur.x + hx, cur.y + hy)
        });
        let cp2 = next.handle_in.map_or(Coord2(next.x, next.y), |(hx, hy)| {
            Coord2(next.x + hx, next.y + hy)
        });
        let end = Coord2(next.x, next.y);
        points.push((cp1, cp2, end));
    }
    (start, points)
}

fn path_to_contour(path: &SimpleBezierPath) -> Contour {
    let (start, points) = path;
    let mut nodes = vec![Node {
        x: start.0,
        y: start.1,
        handle_in: None,
        handle_out: None,
        kind: NodeKind::Corner,
    }];
    for (cp1, cp2, end) in points {
        let prev = nodes.last_mut().expect("nodes is non-empty");
        let out = (cp1.0 - prev.x, cp1.1 - prev.y);
        if out != (0.0, 0.0) {
            prev.handle_out = Some(out);
        }
        let in_handle = (cp2.0 - end.0, cp2.1 - end.1);
        nodes.push(Node {
            x: end.0,
            y: end.1,
            handle_in: if in_handle != (0.0, 0.0) {
                Some(in_handle)
            } else {
                None
            },
            handle_out: None,
            kind: NodeKind::Corner,
        });
    }
    Contour {
        nodes,
        closed: true,
        fill_rule: FillRule::Nonzero,
    }
}

fn binary(a: &SimpleBezierPath, b: &SimpleBezierPath, op: BooleanOp) -> Vec<SimpleBezierPath> {
    let a = PathCombine::Path(vec![a.clone()]);
    let b = PathCombine::Path(vec![b.clone()]);
    let operation = match op {
        BooleanOp::Union => PathCombine::Add(vec![a, b]),
        BooleanOp::Difference => PathCombine::Subtract(vec![a, b]),
        BooleanOp::Intersect => PathCombine::Intersect(vec![a, b]),
        BooleanOp::Exclude => {
            let union = PathCombine::Add(vec![a.clone(), b.clone()]);
            let intersection = PathCombine::Intersect(vec![a, b]);
            PathCombine::Subtract(vec![union, intersection])
        }
    };
    path_combine(operation, ACCURACY)
}

fn union_all(paths: &[SimpleBezierPath]) -> Vec<SimpleBezierPath> {
    let mut result: Vec<SimpleBezierPath> = Vec::new();
    for path in paths {
        result = if result.is_empty() {
            vec![path.clone()]
        } else {
            path_combine(
                PathCombine::Add(vec![
                    PathCombine::Path(result),
                    PathCombine::Path(vec![path.clone()]),
                ]),
                ACCURACY,
            )
        };
    }
    result
}

fn intersect_all(paths: &[SimpleBezierPath]) -> Vec<SimpleBezierPath> {
    let mut result: Vec<SimpleBezierPath> = Vec::new();
    for path in paths {
        result = if result.is_empty() {
            vec![path.clone()]
        } else {
            path_combine(
                PathCombine::Intersect(vec![
                    PathCombine::Path(result),
                    PathCombine::Path(vec![path.clone()]),
                ]),
                ACCURACY,
            )
        };
    }
    result
}

/// Apply a boolean across a glyph's contours.
///
/// - `union`: merge every contour into one outline.
/// - `difference`: subtract the last contour from the union of the rest.
/// - `intersect`: keep only the area common to every contour.
/// - `exclude`: union minus intersection.
pub fn apply(contours: &[Contour], op: BooleanOp) -> Vec<Contour> {
    if contours.is_empty() {
        return Vec::new();
    }
    if contours.len() == 1 {
        return match op {
            BooleanOp::Union => contours.to_vec(),
            _ => Vec::new(),
        };
    }

    let paths: Vec<SimpleBezierPath> = contours.iter().map(contour_to_path).collect();
    let result = match op {
        BooleanOp::Union => union_all(&paths),
        BooleanOp::Intersect => intersect_all(&paths),
        BooleanOp::Difference => {
            let front = paths.last().expect("len > 1");
            let back = union_all(&paths[..paths.len() - 1]);
            if back.is_empty() {
                vec![front.clone()]
            } else {
                let back = back.into_iter().next().expect("non-empty");
                binary(&back, front, BooleanOp::Difference)
            }
        }
        BooleanOp::Exclude => {
            let union = union_all(&paths);
            let intersection = intersect_all(&paths);
            if union.is_empty() {
                Vec::new()
            } else if intersection.is_empty() {
                union
            } else {
                let union = union.into_iter().next().expect("non-empty");
                let intersection = intersection.into_iter().next().expect("non-empty");
                binary(&union, &intersection, BooleanOp::Difference)
            }
        }
    };

    result.iter().map(path_to_contour).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, w: f64, h: f64) -> Contour {
        let nodes = vec![
            Node {
                x,
                y,
                handle_in: None,
                handle_out: None,
                kind: NodeKind::Corner,
            },
            Node {
                x: x + w,
                y,
                handle_in: None,
                handle_out: None,
                kind: NodeKind::Corner,
            },
            Node {
                x: x + w,
                y: y + h,
                handle_in: None,
                handle_out: None,
                kind: NodeKind::Corner,
            },
            Node {
                x,
                y: y + h,
                handle_in: None,
                handle_out: None,
                kind: NodeKind::Corner,
            },
        ];
        Contour {
            nodes,
            closed: true,
            fill_rule: FillRule::Nonzero,
        }
    }

    fn bounds(contours: &[Contour]) -> (f64, f64, f64, f64) {
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for contour in contours {
            for node in &contour.nodes {
                min_x = min_x.min(node.x);
                max_x = max_x.max(node.x);
                min_y = min_y.min(node.y);
                max_y = max_y.max(node.y);
            }
        }
        (min_x, min_y, max_x, max_y)
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.5
    }

    #[test]
    fn union_merges_overlapping_squares() {
        let a = square(0.0, 0.0, 100.0, 100.0);
        let b = square(50.0, 0.0, 100.0, 100.0);
        let result = apply(&[a, b], BooleanOp::Union);
        assert_eq!(result.len(), 1, "union of two squares is one outline");
        let (min_x, min_y, max_x, max_y) = bounds(&result);
        assert!(approx(min_x, 0.0) && approx(min_y, 0.0));
        assert!(approx(max_x, 150.0) && approx(max_y, 100.0));
    }

    #[test]
    fn intersect_keeps_only_the_overlap() {
        let a = square(0.0, 0.0, 100.0, 100.0);
        let b = square(50.0, 0.0, 100.0, 100.0);
        let result = apply(&[a, b], BooleanOp::Intersect);
        assert_eq!(result.len(), 1);
        let (min_x, min_y, max_x, max_y) = bounds(&result);
        assert!(approx(min_x, 50.0) && approx(min_y, 0.0));
        assert!(approx(max_x, 100.0) && approx(max_y, 100.0));
    }

    #[test]
    fn difference_subtracts_the_front_shape() {
        let a = square(0.0, 0.0, 100.0, 100.0);
        let b = square(50.0, 0.0, 100.0, 100.0);
        // Front (last) is `b`; the result is `a` minus `b`.
        let result = apply(&[a, b], BooleanOp::Difference);
        assert_eq!(result.len(), 1);
        let (min_x, min_y, max_x, max_y) = bounds(&result);
        assert!(approx(min_x, 0.0) && approx(min_y, 0.0));
        assert!(approx(max_x, 50.0) && approx(max_y, 100.0));
    }

    #[test]
    fn union_preserves_cubic_curves() {
        // A circle approximated by four cubic arcs, unioned with a copy offset
        // to the right. The result must still carry Bezier handles — flo_curves
        // must not flatten to polygons.
        let k = 0.552_284_749_830_793_6;
        let circle = |cx: f64, cy: f64, r: f64| Contour {
            nodes: vec![
                Node {
                    x: cx + r,
                    y: cy,
                    handle_out: Some((0.0, r * k)),
                    handle_in: Some((0.0, -r * k)),
                    kind: NodeKind::Corner,
                },
                Node {
                    x: cx,
                    y: cy + r,
                    handle_out: Some((-r * k, 0.0)),
                    handle_in: Some((r * k, 0.0)),
                    kind: NodeKind::Corner,
                },
                Node {
                    x: cx - r,
                    y: cy,
                    handle_out: Some((0.0, -r * k)),
                    handle_in: Some((0.0, r * k)),
                    kind: NodeKind::Corner,
                },
                Node {
                    x: cx,
                    y: cy - r,
                    handle_out: Some((r * k, 0.0)),
                    handle_in: Some((-r * k, 0.0)),
                    kind: NodeKind::Corner,
                },
            ],
            closed: true,
            fill_rule: FillRule::Nonzero,
        };

        let result = apply(
            &[circle(0.0, 0.0, 100.0), circle(100.0, 0.0, 100.0)],
            BooleanOp::Union,
        );
        assert!(!result.is_empty());
        let has_curve = result
            .iter()
            .flat_map(|contour| &contour.nodes)
            .any(|node| node.handle_in.is_some() || node.handle_out.is_some());
        assert!(has_curve, "union of two circles keeps cubic curves");
    }
}
