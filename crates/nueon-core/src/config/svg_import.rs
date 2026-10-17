//! SVG import: a real XML parse (`roxmltree`, DTD disallowed so no entity
//! expansion), shapes and `<path>` data including arcs (`kurbo`), transforms
//! (`translate`, `scale`, `rotate`, `matrix`) accumulated from ancestors, and
//! the root `viewBox` fitted to the em box with the y flip. Pure: everything
//! is testable without a workspace.

use kurbo::{Affine, BezPath, PathEl, Point as KPoint, Vec2 as KVec2};
use roxmltree::{Document, Node, ParsingOptions};

use super::{Contour, Node as GNode, NodeKind};

/// What an import produced: the drawn contours (glyph coordinates, y up) and
/// the element kinds that were skipped because they are not drawn shapes.
#[derive(Debug, Default, PartialEq)]
pub struct SvgImport {
    pub contours: Vec<Contour>,
    pub skipped: Vec<(String, usize)>,
}

impl SvgImport {
    fn skip(&mut self, kind: &str) {
        if let Some((_, count)) = self.skipped.iter_mut().find(|(k, _)| k == kind) {
            *count += 1;
        } else {
            self.skipped.push((kind.to_string(), 1));
        }
    }
}

/// Parse `svg` and convert every drawn shape to contours in glyph space.
/// `upem` is the em box the root `viewBox` is fitted into (y flipped); with no
/// `viewBox` the SVG's own units are kept and only y is flipped.
pub fn import_svg(svg: &str, upem: f64) -> Result<SvgImport, String> {
    // DTDs are disallowed, so external entities are never fetched or expanded.
    let options = ParsingOptions {
        allow_dtd: false,
        ..Default::default()
    };
    let doc = Document::parse_with_options(svg, options)
        .map_err(|e| format!("not an SVG document: {e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" {
        return Err(format!(
            "root element is <{}>, not <svg>",
            root.tag_name().name()
        ));
    }
    let view_box = read_view_box(root)?;
    let mut imported = SvgImport::default();
    walk(root, Affine::IDENTITY, &mut imported)?;
    fit_to_em(&mut imported.contours, view_box, upem);
    Ok(imported)
}

/// The root `viewBox` as `(minx, miny, width, height)`.
fn read_view_box(root: Node) -> Result<Option<(f64, f64, f64, f64)>, String> {
    let Some(value) = root.attribute("viewBox") else {
        return Ok(None);
    };
    let parts: Vec<f64> = value
        .split_whitespace()
        .map(|n| n.parse::<f64>())
        .collect::<Result<_, _>>()
        .map_err(|_| format!("unreadable viewBox: {value}"))?;
    if parts.len() != 4 || parts[2] <= 0.0 || parts[3] <= 0.0 {
        return Err(format!("unreadable viewBox: {value}"));
    }
    Ok(Some((parts[0], parts[1], parts[2], parts[3])))
}

/// Recurse through the XML, accumulating transforms, drawing shapes.
fn walk(node: Node, transform: Affine, imported: &mut SvgImport) -> Result<(), String> {
    let transform = match node.attribute("transform") {
        Some(value) => transform * parse_transform(value)?,
        None => transform,
    };
    match node.tag_name().name() {
        "svg" | "g" | "a" | "defs" | "symbol" | "marker" | "clipPath" | "mask" | "pattern" => {
            // Containers: note the non-rendering ones as skipped so a report
            // can say what was ignored, but keep walking their children.
            if matches!(
                node.tag_name().name(),
                "defs" | "symbol" | "marker" | "clipPath" | "mask" | "pattern"
            ) {
                imported.skip(&format!("<{}>", node.tag_name().name()));
            }
            for child in node.children() {
                walk(child, transform, imported)?;
            }
            Ok(())
        }
        "path" => {
            if let Some(d) = node.attribute("d") {
                if !d.trim().is_empty() {
                    let path =
                        BezPath::from_svg(d).map_err(|e| format!("unreadable path data: {e}"))?;
                    for contour in path_to_contours(&path, transform) {
                        imported.contours.push(contour);
                    }
                }
            }
            Ok(())
        }
        "rect" => {
            if let Some(rect) = read_rect(node) {
                imported.contours.push(rect_to_contour(&rect, transform));
            }
            Ok(())
        }
        "circle" | "ellipse" => {
            if let Some(ellipse) = read_ellipse(node) {
                imported
                    .contours
                    .push(ellipse_to_contour(&ellipse, transform));
            }
            Ok(())
        }
        "line" => {
            if let Some((a, b)) = read_line(node) {
                imported.contours.push(line_to_contour(a, b, transform));
            }
            Ok(())
        }
        "polyline" | "polygon" => {
            let closed = node.tag_name().name() == "polygon";
            if let Some(points) = read_points(node) {
                if points.len() >= 2 {
                    imported
                        .contours
                        .push(points_to_contour(&points, closed, transform));
                }
            }
            Ok(())
        }
        "use" => {
            // `<use href>` needs id resolution across the document; noted as
            // skipped rather than silently dropped.
            imported.skip("<use>");
            Ok(())
        }
        "text" | "tspan" => {
            imported.skip("<text>");
            Ok(())
        }
        "image" => {
            imported.skip("<image>");
            Ok(())
        }
        _ => {
            // Unknown elements (metadata, title, RDF, editors' private tags)
            // are common in real files; counted, not fatal.
            imported.skip(&format!("<{}>", node.tag_name().name()));
            for child in node.children() {
                walk(child, transform, imported)?;
            }
            Ok(())
        }
    }
}

/// Parse a `transform` attribute: any number of `translate`, `scale`,
/// `rotate` (with optional centre) and `matrix` calls, left to right.
fn parse_transform(value: &str) -> Result<Affine, String> {
    let mut combined = Affine::IDENTITY;
    let bytes = value.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        while at < bytes.len() && (bytes[at].is_ascii_whitespace() || bytes[at] == b',') {
            at += 1;
        }
        if at >= bytes.len() {
            break;
        }
        let name_start = at;
        while at < bytes.len() && bytes[at].is_ascii_alphabetic() {
            at += 1;
        }
        let name = &value[name_start..at];
        while at < bytes.len() && (bytes[at].is_ascii_whitespace() || bytes[at] == b'(') {
            at += 1;
        }
        let mut numbers = Vec::new();
        loop {
            while at < bytes.len() && (bytes[at].is_ascii_whitespace() || bytes[at] == b',') {
                at += 1;
            }
            if at >= bytes.len() || bytes[at] == b')' {
                if at < bytes.len() {
                    at += 1;
                }
                break;
            }
            let start = at;
            while at < bytes.len()
                && (bytes[at].is_ascii_digit()
                    || matches!(bytes[at], b'.' | b'-' | b'+' | b'e' | b'E'))
            {
                at += 1;
            }
            if start == at {
                return Err(format!("unreadable transform: {value}"));
            }
            let n: f64 = value[start..at]
                .parse()
                .map_err(|_| format!("unreadable transform: {value}"))?;
            numbers.push(n);
        }
        let affine = match name {
            "translate" => match numbers.as_slice() {
                [tx] => Affine::translate(KVec2::new(*tx, 0.0)),
                [tx, ty] => Affine::translate(KVec2::new(*tx, *ty)),
                _ => return Err(format!("translate takes one or two numbers: {value}")),
            },
            "scale" => match numbers.as_slice() {
                [s] => Affine::scale(*s),
                [sx, sy] => Affine::scale_non_uniform(*sx, *sy),
                _ => return Err(format!("scale takes one or two numbers: {value}")),
            },
            "rotate" => match numbers.as_slice() {
                [a] => Affine::rotate(a.to_radians()),
                [a, cx, cy] => {
                    let centre = KPoint::new(*cx, *cy);
                    Affine::translate(centre.to_vec2())
                        * Affine::rotate(a.to_radians())
                        * Affine::translate(-centre.to_vec2())
                }
                _ => return Err(format!("rotate takes one or three numbers: {value}")),
            },
            "matrix" => match numbers.as_slice() {
                [a, b, c, d, e, f] => Affine::new([*a, *b, *c, *d, *e, *f]),
                _ => return Err(format!("matrix takes six numbers: {value}")),
            },
            _ => return Err(format!("unsupported transform: {name} in {value}")),
        };
        combined *= affine;
    }
    Ok(combined)
}

/// Convert a parsed path's elements into contours (open between moves). The
/// transform is applied to the whole path up front so node positions and
/// handle deltas land in the same space.
fn path_to_contours(path: &BezPath, transform: Affine) -> Vec<Contour> {
    let path = transform * path;
    let mut contours: Vec<Contour> = Vec::new();
    let mut nodes: Vec<GNode> = Vec::new();
    for element in path.elements() {
        match element {
            PathEl::MoveTo(p) => {
                push_contour(&mut contours, &mut nodes, false);
                nodes.push(GNode {
                    x: p.x,
                    y: p.y,
                    handle_in: None,
                    handle_out: None,
                    kind: NodeKind::Corner,
                });
            }
            PathEl::LineTo(p) => {
                nodes.push(GNode {
                    x: p.x,
                    y: p.y,
                    handle_in: None,
                    handle_out: None,
                    kind: NodeKind::Corner,
                });
            }
            PathEl::CurveTo(p1, p2, p3) => {
                if let Some(prev) = nodes.last_mut() {
                    prev.handle_out = Some((p1.x - prev.x, p1.y - prev.y));
                }
                nodes.push(GNode {
                    x: p3.x,
                    y: p3.y,
                    handle_in: Some((p2.x - p3.x, p2.y - p3.y)),
                    handle_out: None,
                    kind: NodeKind::Corner,
                });
            }
            PathEl::QuadTo(p1, p2) => {
                // A quadratic is one cubic with both handles on the chord
                // two-thirds out.
                if let Some(prev) = nodes.last_mut() {
                    prev.handle_out =
                        Some(((p1.x - prev.x) * 2.0 / 3.0, (p1.y - prev.y) * 2.0 / 3.0));
                }
                nodes.push(GNode {
                    x: p2.x,
                    y: p2.y,
                    handle_in: Some(((p1.x - p2.x) * 2.0 / 3.0, (p1.y - p2.y) * 2.0 / 3.0)),
                    handle_out: None,
                    kind: NodeKind::Corner,
                });
            }
            PathEl::ClosePath => {
                push_contour(&mut contours, &mut nodes, true);
            }
        }
    }
    push_contour(&mut contours, &mut nodes, false);
    contours
}

fn push_contour(contours: &mut Vec<Contour>, nodes: &mut Vec<GNode>, closed: bool) {
    if nodes.len() >= 2 {
        let mut taken = std::mem::take(nodes);
        // Z does not duplicate the start point; a path that returns to its
        // start before Z keeps one node there, the duplicate's incoming
        // handle moving to the survivor.
        if closed && taken.len() > 2 {
            let first = taken[0];
            let last = *taken.last().expect("non-empty");
            if (first.x - last.x).abs() < 1e-9 && (first.y - last.y).abs() < 1e-9 {
                taken.pop();
                taken[0].handle_in = last.handle_in;
            }
        }
        contours.push(Contour {
            nodes: taken,
            closed,
            fill_rule: super::FillRule::Nonzero,
        });
    } else {
        nodes.clear();
    }
}

fn read_rect(node: Node) -> Option<(f64, f64, f64, f64, f64, f64)> {
    let num = |name| node.attribute(name)?.parse::<f64>().ok();
    Some((
        node.attribute("x")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0),
        node.attribute("y")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0),
        num("width")?,
        num("height")?,
        node.attribute("rx")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0),
        node.attribute("ry")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0),
    ))
}

fn read_ellipse(node: Node) -> Option<(f64, f64, f64, f64)> {
    let num = |name| node.attribute(name)?.parse::<f64>().ok();
    let cx = node
        .attribute("cx")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);
    let cy = node
        .attribute("cy")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);
    match node.tag_name().name() {
        "circle" => Some((cx, cy, num("r")?, num("r")?)),
        _ => Some((cx, cy, num("rx")?, num("ry")?)),
    }
}

fn read_line(node: Node) -> Option<((f64, f64), (f64, f64))> {
    let num = |name| node.attribute(name)?.parse::<f64>().ok();
    Some(((num("x1")?, num("y1")?), (num("x2")?, num("y2")?)))
}

fn read_points(node: Node) -> Option<Vec<(f64, f64)>> {
    let value = node.attribute("points")?;
    let mut points = Vec::new();
    let mut pair = Vec::new();
    for token in value.split(|c: char| c.is_whitespace() || c == ',') {
        if token.is_empty() {
            continue;
        }
        if let Ok(n) = token.parse::<f64>() {
            pair.push(n);
            if pair.len() == 2 {
                points.push((pair[0], pair[1]));
                pair.clear();
            }
        } else {
            return None;
        }
    }
    if !pair.is_empty() {
        return None;
    }
    Some(points)
}

fn rect_to_contour(rect: &(f64, f64, f64, f64, f64, f64), transform: Affine) -> Contour {
    let (x, y, w, h, rx, ry) = *rect;
    let mut nodes: Vec<GNode> = Vec::new();
    let corner = |px: f64, py: f64| {
        let q = transform * KPoint::new(px, py);
        GNode {
            x: q.x,
            y: q.y,
            handle_in: None,
            handle_out: None,
            kind: NodeKind::Corner,
        }
    };
    if rx <= 0.0 && ry <= 0.0 {
        nodes.push(corner(x, y));
        nodes.push(corner(x + w, y));
        nodes.push(corner(x + w, y + h));
        nodes.push(corner(x, y + h));
    } else {
        // Rounded corners as quarter circles (the standard kappa constants):
        // two tangent nodes per corner, starting on the top edge.
        let rx = rx.min(w / 2.0);
        let ry = if ry <= 0.0 { rx } else { ry.min(h / 2.0) };
        let k = 0.5522847498307936;
        let stops = [
            (x + rx, y),
            (x + w - rx, y),
            (x + w, y + ry),
            (x + w, y + h - ry),
            (x + w - rx, y + h),
            (x + rx, y + h),
            (x, y + h - ry),
            (x, y + ry),
        ];
        // handles[i]: the outgoing and incoming handles of stops[i].
        let handles = [
            ((rx * k, 0.0), (-rx * k, 0.0)),
            ((0.0, ry * k), (-rx * k, 0.0)),
            ((0.0, ry * k), (0.0, -ry * k)),
            ((-rx * k, 0.0), (0.0, -ry * k)),
            ((-rx * k, 0.0), (rx * k, 0.0)),
            ((0.0, -ry * k), (rx * k, 0.0)),
            ((0.0, -ry * k), (0.0, ry * k)),
            ((rx * k, 0.0), (0.0, ry * k)),
        ];
        for i in 0..8 {
            let pos = transform * KPoint::new(stops[i].0, stops[i].1);
            let (out_h, in_h) = handles[i];
            let out = transform * KPoint::new(stops[i].0 + out_h.0, stops[i].1 + out_h.1);
            let inc = transform * KPoint::new(stops[i].0 + in_h.0, stops[i].1 + in_h.1);
            nodes.push(GNode {
                x: pos.x,
                y: pos.y,
                handle_in: Some((inc.x - pos.x, inc.y - pos.y)),
                handle_out: Some((out.x - pos.x, out.y - pos.y)),
                kind: NodeKind::Corner,
            });
        }
    }
    Contour {
        nodes,
        closed: true,
        fill_rule: super::FillRule::Nonzero,
    }
}

fn ellipse_to_contour(ellipse: &(f64, f64, f64, f64), transform: Affine) -> Contour {
    let (cx, cy, rx, ry) = *ellipse;
    let k = 0.5522847498307936;
    let corners = [(1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)];
    // handles[i]: the outgoing handle of corner i, the incoming handle of
    // corner i+1.
    let handles = [
        ((k * rx, 0.0), (0.0, k * ry)),
        ((0.0, k * ry), (-k * rx, 0.0)),
        ((-k * rx, 0.0), (0.0, -k * ry)),
        ((0.0, -k * ry), (k * rx, 0.0)),
    ];
    let mut nodes: Vec<GNode> = Vec::new();
    for i in 0..4 {
        let pos = transform * KPoint::new(cx + corners[i].0 * rx, cy + corners[i].1 * ry);
        let (out_h, _) = handles[i];
        let (_, in_h) = handles[(i + 3) % 4];
        let out = transform
            * KPoint::new(
                cx + corners[i].0 * rx + out_h.0,
                cy + corners[i].1 * ry + out_h.1,
            );
        let inc = transform
            * KPoint::new(
                cx + corners[i].0 * rx + in_h.0,
                cy + corners[i].1 * ry + in_h.1,
            );
        nodes.push(GNode {
            x: pos.x,
            y: pos.y,
            handle_in: Some((inc.x - pos.x, inc.y - pos.y)),
            handle_out: Some((out.x - pos.x, out.y - pos.y)),
            kind: NodeKind::Corner,
        });
    }
    Contour {
        nodes,
        closed: true,
        fill_rule: super::FillRule::Nonzero,
    }
}

fn line_to_contour(a: (f64, f64), b: (f64, f64), transform: Affine) -> Contour {
    let map = |(x, y): (f64, f64)| {
        let q = transform * KPoint::new(x, y);
        GNode {
            x: q.x,
            y: q.y,
            handle_in: None,
            handle_out: None,
            kind: NodeKind::Corner,
        }
    };
    Contour {
        nodes: vec![map(a), map(b)],
        closed: false,
        fill_rule: super::FillRule::Nonzero,
    }
}

fn points_to_contour(points: &[(f64, f64)], closed: bool, transform: Affine) -> Contour {
    let nodes = points
        .iter()
        .map(|&(x, y)| {
            let q = transform * KPoint::new(x, y);
            GNode {
                x: q.x,
                y: q.y,
                handle_in: None,
                handle_out: None,
                kind: NodeKind::Corner,
            }
        })
        .collect();
    Contour {
        nodes,
        closed,
        fill_rule: super::FillRule::Nonzero,
    }
}

/// Fit the contours to the em box: with a `viewBox`, scale it uniformly into
/// `upem` (centred on the narrower axis) and flip y — the viewBox's top maps
/// to the em box's top; without one, keep the SVG's own units and only flip
/// y. Handles are deltas: they scale with the mapping and their y flips with
/// it.
fn fit_to_em(contours: &mut [Contour], view_box: Option<(f64, f64, f64, f64)>, upem: f64) {
    let map = match view_box {
        Some((minx, miny, w, h)) => {
            let scale = upem / w.max(h);
            let offset_x = (upem - w * scale) / 2.0;
            let offset_y = (upem - h * scale) / 2.0;
            Some((scale, minx, miny, h, offset_x, offset_y))
        }
        None => None,
    };
    for contour in contours.iter_mut() {
        for node in contour.nodes.iter_mut() {
            match map {
                Some((scale, minx, miny, h, offset_x, offset_y)) => {
                    node.x = offset_x + (node.x - minx) * scale;
                    node.y = offset_y + (h - (node.y - miny)) * scale;
                    if let Some((hx, hy)) = node.handle_in {
                        node.handle_in = Some((hx * scale, -hy * scale));
                    }
                    if let Some((hx, hy)) = node.handle_out {
                        node.handle_out = Some((hx * scale, -hy * scale));
                    }
                }
                None => {
                    node.y = -node.y;
                    if let Some((hx, hy)) = node.handle_in {
                        node.handle_in = Some((hx, -hy));
                    }
                    if let Some((hx, hy)) = node.handle_out {
                        node.handle_out = Some((hx, -hy));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes_of(contour: &Contour) -> Vec<(f64, f64)> {
        contour.nodes.iter().map(|n| (n.x, n.y)).collect()
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.5
    }

    /// An Inkscape-style document: XML declaration, tab-indented, named
    /// groups with transforms, a path with arcs, a rect and a circle.
    const INKSCAPE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   xmlns="http://www.w3.org/2000/svg"
   viewBox="0 0 100 100"
   version="1.1">
  <defs
     id="defs1">
    <linearGradient
       id="grad">
      <stop
         offset="0"
         style="stop-color:#000000" />
    </linearGradient>
  </defs>
  <g
     id="layer1"
     transform="translate(10,10)">
    <path
       id="outline"
       style="fill:#000000"
       d="M 0,0 A 25,25 0 0 1 50,0 L 50,40 L 0,40 Z" />
    <g
       id="inner"
       transform="rotate(90 25 25)">
      <rect
         id="box"
         x="5"
         y="5"
         width="20"
         height="10" />
    </g>
    <circle
       id="dot"
       cx="80"
       cy="80"
       r="5" />
  </g>
  <text
     id="label">hello</text>
</svg>
"#;

    #[test]
    fn parses_inkscape_style_documents() {
        let imported = import_svg(INKSCAPE, 1000.0).unwrap();
        assert_eq!(
            imported.contours.len(),
            3,
            "the arc path, the rect and the circle"
        );
        // The viewBox is square (100), so scale = 10 and no centring offsets.
        // The arc path: translated by (10,10), so the (0,0) start maps to
        // (100, 900) in y-up glyph space.
        let path = &imported.contours[0];
        assert!(path.closed, "the path ends with Z");
        let first = path.nodes[0];
        assert!(
            approx(first.x, 100.0) && approx(first.y, 900.0),
            "translate applied and y flipped"
        );
        // The arc endpoint (50,0) → translated (60,10) → glyph (600,900);
        // kurbo splits the semicircle into two cubics whose join sits at the
        // top, svg (25,-25) → glyph (350,1150). The trailing L 50,40 and
        // L 0,40 stay as corner nodes — Z closes without dropping them.
        let has = |x: f64, y: f64| path.nodes.iter().any(|n| approx(n.x, x) && approx(n.y, y));
        assert!(has(600.0, 900.0), "the arc's end: {:?}", path.nodes);
        assert!(
            has(350.0, 1150.0),
            "the arc's top, bulging up in y-up space: {:?}",
            path.nodes
        );
        assert!(has(600.0, 500.0), "L 50,40 kept: {:?}", path.nodes);
        assert!(has(100.0, 500.0), "L 0,40 kept: {:?}", path.nodes);
        assert_eq!(
            path.nodes.len(),
            5,
            "M, the arc's join, the arc's end, two lines: {:?}",
            path.nodes
        );
        // The skipped kinds are reported.
        assert!(
            imported.skipped.iter().any(|(k, _)| k == "<text>"),
            "text is skipped and counted: {:?}",
            imported.skipped
        );
        assert!(
            imported
                .skipped
                .iter()
                .any(|(k, _)| k == "<linearGradient>"),
            "gradient is skipped: {:?}",
            imported.skipped
        );
    }

    #[test]
    fn transforms_compose_from_ancestors() {
        // The rect sits in a rotated group inside a translated group; its
        // corners are the rotated rectangle, not the axis-aligned one.
        let imported = import_svg(INKSCAPE, 1000.0).unwrap();
        let rect = &imported.contours[1];
        assert!(rect.closed);
        let xs: Vec<f64> = rect.nodes.iter().map(|n| n.x).collect();
        let ys: Vec<f64> = rect.nodes.iter().map(|n| n.y).collect();
        // A 90-degree rotation of a 200x100-unit rect makes its y-span wider
        // than its x-span.
        let span = |v: &[f64]| {
            v.iter()
                .cloned()
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| {
                    (lo.min(x), hi.max(x))
                })
        };
        let (x_lo, x_hi) = span(&xs);
        let (y_lo, y_hi) = span(&ys);
        assert!(
            (y_hi - y_lo) > (x_hi - x_lo),
            "the rect is rotated 90 degrees"
        );
    }

    /// An Illustrator-style document: no XML declaration, named layers with
    /// matrix transforms, an ellipse, a polyline and a polygon.
    const ILLUSTRATOR: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 100\">\n\t<g id=\"Layer_1\" transform=\"matrix(1 0 0 1 20 0)\">\n\t\t<ellipse cx=\"50\" cy=\"50\" rx=\"30\" ry=\"20\"/>\n\t\t<polyline points=\"10,80 30,90 50,85\"/>\n\t\t<polygon points=\"120,10 160,10 140,40\"/>\n\t</g>\n</svg>\n";

    #[test]
    fn parses_illustrator_style_documents() {
        let imported = import_svg(ILLUSTRATOR, 1000.0).unwrap();
        assert_eq!(imported.contours.len(), 3, "ellipse, polyline, polygon");
        assert!(imported.contours[0].closed, "an ellipse is closed");
        assert!(!imported.contours[1].closed, "a polyline is open");
        assert!(imported.contours[2].closed, "a polygon is closed");
        // viewBox 200x100: scale = 1000/200 = 5, y centred: offset_y =
        // (1000 - 100*5)/2 = 250, so svg y=50 maps to 250 + (100-50)*5 = 500
        // and the extremes (cy ± ry = 30/70) map to 600 and 400. The
        // translate(20,0) moves x only.
        let ys: Vec<f64> = imported.contours[0].nodes.iter().map(|n| n.y).collect();
        let hi = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let lo = ys.iter().cloned().fold(f64::INFINITY, f64::min);
        assert!(
            approx(lo, 400.0),
            "the ellipse's lowest point (cy + ry = 70 svg): {:?}",
            ys
        );
        assert!(
            approx(hi, 600.0),
            "the ellipse's highest point (cy - ry = 30 svg): {:?}",
            ys
        );
        assert!(
            ys.iter().filter(|y| approx(**y, 500.0)).count() == 2,
            "the left and right extremes sit on the centre line: {:?}",
            ys
        );
        // A polyline is open and has exactly its points as corner nodes.
        assert_eq!(imported.contours[1].nodes.len(), 3);
        assert!(imported.contours[1]
            .nodes
            .iter()
            .all(|n| n.handle_in.is_none() && n.handle_out.is_none()));
    }

    #[test]
    fn a_viewbox_is_fitted_to_the_em_box_and_y_flipped() {
        // A tall viewBox (100x400) maps into a 1000-unit em box with
        // scale 2.5, centred horizontally at x=375..625.
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 400\"><path d=\"M 0,0 L 100,0 L 100,400 L 0,400 Z\"/></svg>";
        let imported = import_svg(svg, 1000.0).unwrap();
        let points = nodes_of(&imported.contours[0]);
        assert!(
            approx(points[0].0, 375.0) && approx(points[0].1, 1000.0),
            "the viewBox's top-left maps to the em box's top, centred: {points:?}"
        );
        assert!(
            approx(points[2].0, 625.0) && approx(points[2].1, 0.0),
            "the bottom-right maps to the em box's bottom: {points:?}"
        );
    }

    #[test]
    fn without_a_viewbox_units_are_kept_and_y_flips() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M 10,20 L 110,20\"/></svg>";
        let imported = import_svg(svg, 1000.0).unwrap();
        let points = nodes_of(&imported.contours[0]);
        assert!(
            approx(points[0].0, 10.0) && approx(points[0].1, -20.0),
            "y is flipped only: {points:?}"
        );
        assert!(!imported.contours[0].closed, "an open path stays open");
    }

    #[test]
    fn a_line_is_two_open_nodes() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><line x1=\"0\" y1=\"0\" x2=\"50\" y2=\"50\"/></svg>";
        let imported = import_svg(svg, 1000.0).unwrap();
        assert_eq!(imported.contours.len(), 1);
        assert_eq!(imported.contours[0].nodes.len(), 2);
        assert!(!imported.contours[0].closed);
    }

    #[test]
    fn a_use_and_an_image_are_reported_not_dropped_silently() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\"><use xlink:href=\"#shape\"/><image href=\"cat.png\" x=\"0\" y=\"0\" width=\"10\" height=\"10\"/></svg>";
        let imported = import_svg(svg, 1000.0).unwrap();
        assert!(imported.contours.is_empty());
        let kinds: Vec<&str> = imported.skipped.iter().map(|(k, _)| k.as_str()).collect();
        assert!(kinds.contains(&"<use>"), "{kinds:?}");
        assert!(kinds.contains(&"<image>"), "{kinds:?}");
    }

    #[test]
    fn junk_and_dtds_are_refused() {
        assert!(
            import_svg("<div>not svg</div>", 1000.0).is_err(),
            "a non-SVG root"
        );
        assert!(
            import_svg("this is not xml at all <", 1000.0).is_err(),
            "broken XML"
        );
        let with_dtd = "<!DOCTYPE svg [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"&xxe;\"/></svg>";
        assert!(
            import_svg(with_dtd, 1000.0).is_err(),
            "a DTD is refused outright"
        );
    }

    #[test]
    fn a_rounded_rect_carries_handles() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"0\" y=\"0\" width=\"100\" height=\"100\" rx=\"20\"/></svg>";
        let imported = import_svg(svg, 1000.0).unwrap();
        let rect = &imported.contours[0];
        assert!(
            rect.nodes.iter().any(|n| n.handle_out.is_some()),
            "rounded corners have handles"
        );
        assert!(rect.closed);
    }

    #[test]
    fn an_ellipse_is_four_arcs_through_the_extremes() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><ellipse cx=\"50\" cy=\"50\" rx=\"30\" ry=\"20\"/></svg>";
        let imported = import_svg(svg, 1000.0).unwrap();
        let points = nodes_of(&imported.contours[0]);
        // The four nodes sit exactly on the ellipse's extremes (scale 10).
        assert!(
            points
                .iter()
                .any(|(x, y)| approx(*x, 500.0) && approx(*y, 300.0)),
            "top: {points:?}"
        );
        assert!(
            points
                .iter()
                .any(|(x, y)| approx(*x, 800.0) && approx(*y, 500.0)),
            "right: {points:?}"
        );
        assert!(
            points
                .iter()
                .any(|(x, y)| approx(*x, 500.0) && approx(*y, 700.0)),
            "bottom: {points:?}"
        );
        assert!(
            points
                .iter()
                .any(|(x, y)| approx(*x, 200.0) && approx(*y, 500.0)),
            "left: {points:?}"
        );
    }
}
