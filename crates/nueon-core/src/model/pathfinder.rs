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

/// Combine two whole sets of paths. Every side can hold several pieces (a
/// union of disjoint shapes, holes), and every piece must reach the boolean:
/// dropping all but the first silently loses parts of the shape.
fn binary(a: &[SimpleBezierPath], b: &[SimpleBezierPath], op: BooleanOp) -> Vec<SimpleBezierPath> {
    let a = PathCombine::Path(a.to_vec());
    let b = PathCombine::Path(b.to_vec());
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

/// Sample a contour's curves into a polygon for containment tests.
fn flatten(contour: &Contour, steps: usize) -> Vec<Coord2> {
    let mut points = Vec::new();
    let nodes = &contour.nodes;
    let n = nodes.len();
    if n == 0 {
        return points;
    }
    let segments = if contour.closed && n > 1 {
        n
    } else {
        n.saturating_sub(1)
    };
    for i in 0..segments {
        let cur = &nodes[i];
        let next = &nodes[(i + 1) % n];
        let p0 = Coord2(cur.x, cur.y);
        let p1 = cur
            .handle_out
            .map_or(p0, |(hx, hy)| Coord2(cur.x + hx, cur.y + hy));
        let p2 = next.handle_in.map_or(Coord2(next.x, next.y), |(hx, hy)| {
            Coord2(next.x + hx, next.y + hy)
        });
        let p3 = Coord2(next.x, next.y);
        for step in 0..steps {
            let t = step as f64 / steps as f64;
            points.push(de_casteljau(p0, p1, p2, p3, t));
        }
    }
    points
}

fn de_casteljau(p0: Coord2, p1: Coord2, p2: Coord2, p3: Coord2, t: f64) -> Coord2 {
    let lerp = |a: Coord2, b: Coord2| Coord2(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
    let ab = lerp(p0, p1);
    let bc = lerp(p1, p2);
    let cd = lerp(p2, p3);
    let abc = lerp(ab, bc);
    let bcd = lerp(bc, cd);
    lerp(abc, bcd)
}

/// Even-odd containment of a point in a polygon (a ray cast to the right).
fn polygon_contains(polygon: &[Coord2], point: Coord2) -> bool {
    let mut inside = false;
    let n = polygon.len();
    for i in 0..n {
        let a = polygon[i];
        let b = polygon[(i + 1) % n];
        if (a.1 > point.1) != (b.1 > point.1)
            && point.0 < (b.0 - a.0) * (point.1 - a.1) / (b.1 - a.1) + a.0
        {
            inside = !inside;
        }
    }
    inside
}

/// Wind holes the other way. `path_combine` returns every subpath wound the
/// same direction, so a hole (a subpath nested inside another) would fill
/// solid under the nonzero rule the canvas and the compiled font both use.
/// Subpaths at an odd nesting depth are reversed: the outline keeps its
/// direction and holes cut through it, under nonzero and evenodd alike.
fn wind_holes(contours: &mut [Contour]) {
    let polygons: Vec<Vec<Coord2>> = contours.iter().map(|c| flatten(c, 32)).collect();
    for i in 0..contours.len() {
        let start = Coord2(contours[i].nodes[0].x, contours[i].nodes[0].y);
        let depth: usize = (0..contours.len())
            .filter(|&j| i != j && polygon_contains(&polygons[j], start))
            .count();
        if depth % 2 == 1 {
            contours[i].nodes.reverse();
            for node in &mut contours[i].nodes {
                std::mem::swap(&mut node.handle_in, &mut node.handle_out);
            }
        }
    }
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
            let front: Vec<SimpleBezierPath> =
                paths.last().map(|p| vec![p.clone()]).unwrap_or_default();
            let back = union_all(&paths[..paths.len() - 1]);
            if back.is_empty() {
                front
            } else {
                binary(&back, &front, BooleanOp::Difference)
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
                binary(&union, &intersection, BooleanOp::Difference)
            }
        }
    };

    let mut contours: Vec<Contour> = result.iter().map(path_to_contour).collect();
    wind_holes(&mut contours);
    contours
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

    /// Signed shoelace area over a contour's node positions (exact for the
    /// corner-node squares used here). A hole comes back wound the other way,
    /// so summing signed areas lets it cancel its outer contour.
    fn area(contour: &Contour) -> f64 {
        let n = contour.nodes.len();
        if n < 3 {
            return 0.0;
        }
        let mut area = 0.0;
        for i in 0..n {
            let a = &contour.nodes[i];
            let b = &contour.nodes[(i + 1) % n];
            area += a.x * b.y - b.x * a.y;
        }
        area / 2.0
    }

    fn total_area(contours: &[Contour]) -> f64 {
        contours.iter().map(area).sum::<f64>().abs()
    }

    /// Whether the contours' x range covers both `[lo, mid]` and `[hi, hi2]`.
    fn covers_pieces(contours: &[Contour], lo: f64, mid: f64, hi: f64, hi2: f64) -> bool {
        let (min_x, _, max_x, _) = bounds(contours);
        approx(min_x, lo) && approx(max_x, hi2) && contours.len() >= 2 && {
            let xs: Vec<f64> = contours
                .iter()
                .flat_map(|c| c.nodes.iter().map(|n| n.x))
                .collect();
            let has_piece = |a: f64, b: f64| {
                xs.iter().any(|x| approx(*x, a)) && xs.iter().any(|x| approx(*x, b))
            };
            has_piece(lo, mid) && has_piece(hi, hi2)
        }
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
    fn difference_keeps_every_disjoint_piece() {
        // The front cuts only `a`; `b` is a separate piece of the union and
        // must survive instead of being dropped with the rest of the union.
        let a = square(0.0, 0.0, 100.0, 100.0);
        let b = square(300.0, 0.0, 100.0, 100.0);
        let front = square(50.0, 0.0, 100.0, 100.0);
        let result = apply(&[a, b, front], BooleanOp::Difference);
        assert!(
            covers_pieces(&result, 0.0, 50.0, 300.0, 400.0),
            "difference keeps a-minus-front and b: {result:?}"
        );
        let expected = 50.0 * 100.0 + 100.0 * 100.0;
        assert!(
            (total_area(&result) - expected).abs() < 150.0,
            "area is a's remainder plus b: {} vs {expected}",
            total_area(&result)
        );
    }

    #[test]
    fn exclude_keeps_every_disjoint_piece() {
        // Exclusive-or of the three: `a` keeps only what `front` does not
        // cover, `b` survives untouched, and `front`'s own remainder is empty.
        let a = square(0.0, 0.0, 100.0, 100.0);
        let b = square(300.0, 0.0, 100.0, 100.0);
        let front = square(50.0, 0.0, 100.0, 100.0);
        let result = apply(&[a, b, front], BooleanOp::Exclude);
        assert!(
            covers_pieces(&result, 0.0, 50.0, 300.0, 400.0),
            "exclude keeps a-minus-front and b: {result:?}"
        );
        let expected = 50.0 * 100.0 + 100.0 * 100.0;
        assert!(
            (total_area(&result) - expected).abs() < 150.0,
            "area is a's remainder plus b: {} vs {expected}",
            total_area(&result)
        );
    }

    #[test]
    fn intersect_of_disjoint_pieces_is_empty() {
        let a = square(0.0, 0.0, 100.0, 100.0);
        let b = square(300.0, 0.0, 100.0, 100.0);
        let result = apply(&[a, b], BooleanOp::Intersect);
        assert!(result.is_empty(), "nothing is common to both pieces");
    }

    #[test]
    fn difference_keeps_a_hole_as_a_second_contour() {
        // A ring: the hole must survive as its own contour, not vanish with
        // the rest of the inner path.
        let outer = square(0.0, 0.0, 400.0, 400.0);
        let inner = square(100.0, 100.0, 200.0, 200.0);
        let result = apply(&[outer, inner], BooleanOp::Difference);
        assert!(result.len() >= 2, "the hole is its own contour: {result:?}");
        let (min_x, min_y, max_x, max_y) = bounds(&result);
        assert!(approx(min_x, 0.0) && approx(min_y, 0.0));
        assert!(approx(max_x, 400.0) && approx(max_y, 400.0));
        let holes: Vec<&Contour> = result
            .iter()
            .filter(|c| {
                let (x, y, w, h) = bounds(std::slice::from_ref(c));
                approx(x, 100.0) && approx(y, 100.0) && approx(w, 300.0) && approx(h, 300.0)
            })
            .collect();
        assert!(!holes.is_empty(), "the hole's outline is present");
        let outer = result.iter().map(area).sum::<f64>();
        assert!(
            outer > 0.0 && holes.iter().all(|h| area(h) < 0.0),
            "the hole is wound against its outline: signed areas {outer} vs holes {:?}",
            holes.iter().map(|h| area(h)).collect::<Vec<_>>(),
        );
        assert!(
            (total_area(&result) - (400.0 * 400.0 - 200.0 * 200.0)).abs() < 300.0,
            "the ring's area is the outer minus the hole: {}",
            total_area(&result)
        );
    }

    #[test]
    fn difference_of_three_overlapping_shapes_cuts_both_sides() {
        // `a` and `b` overlap into one piece; the front cuts across it.
        let a = square(0.0, 0.0, 100.0, 100.0);
        let b = square(50.0, 0.0, 100.0, 100.0);
        let front = square(60.0, 20.0, 10.0, 60.0);
        let result = apply(&[a, b, front], BooleanOp::Difference);
        let expected = 150.0 * 100.0 - 10.0 * 60.0;
        assert!(
            (total_area(&result) - expected).abs() < 150.0,
            "the union's area minus the front's cut: {} vs {expected}",
            total_area(&result)
        );
        let (min_x, _, max_x, _) = bounds(&result);
        assert!(
            approx(min_x, 0.0) && approx(max_x, 150.0),
            "both sides of the cut survive"
        );
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
