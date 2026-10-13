//! Pure component resolution for the glyph canvas: transform, flatten, expand.
import type { GlyphComponent, GlyphContour, GlyphOutline } from "./api";

export type GlyphLookup = (id: string) => GlyphOutline | null;

const MAX_DEPTH = 16;

function rotScale(x: number, y: number, t: GlyphComponent): [number, number] {
  const sin = Math.sin(t.rotation);
  const cos = Math.cos(t.rotation);
  return [x * t.scale_x * cos - y * t.scale_y * sin, x * t.scale_x * sin + y * t.scale_y * cos];
}

/** Apply a component transform to a contour, mirroring the backend (scale, rotate, translate). */
export function transformContour(contour: GlyphContour, t: GlyphComponent): GlyphContour {
  return {
    ...contour,
    nodes: contour.nodes.map((node) => {
      const [px, py] = rotScale(node.x, node.y, t);
      return {
        x: t.dx + px,
        y: t.dy + py,
        kind: node.kind,
        handle_in: node.handle_in ? rotScale(node.handle_in[0], node.handle_in[1], t) : undefined,
        handle_out: node.handle_out ? rotScale(node.handle_out[0], node.handle_out[1], t) : undefined,
      };
    }),
  };
}

function contoursOf(
  outline: GlyphOutline,
  lookup: GlyphLookup,
  trail: string[],
): GlyphContour[] {
  const out: GlyphContour[] = [];
  for (const element of outline.elements) {
    if (element.kind === "contour") {
      out.push(element);
    } else {
      out.push(...resolveComponent(element, lookup, trail));
    }
  }
  return out;
}

function resolveComponent(
  component: GlyphComponent,
  lookup: GlyphLookup,
  trail: string[],
): GlyphContour[] {
  if (trail.includes(component.glyph) || trail.length >= MAX_DEPTH) return [];
  const target = lookup(component.glyph);
  if (!target) return [];
  return contoursOf(target, lookup, [...trail, component.glyph]).map((c) =>
    transformContour(c, component),
  );
}

/** Each component instance of `outline` flattened to contours, tagged with its element index. */
export function flattenElements(
  outline: GlyphOutline,
  lookup: GlyphLookup,
): { element: number; contours: GlyphContour[] }[] {
  const out: { element: number; contours: GlyphContour[] }[] = [];
  outline.elements.forEach((element, index) => {
    if (element.kind === "component") {
      out.push({ element: index, contours: resolveComponent(element, lookup, []) });
    }
  });
  return out;
}

/** Every glyph id the outline depends on, transitively, each once. */
export function componentIds(outline: GlyphOutline, lookup: GlyphLookup): string[] {
  const seen = new Set<string>();
  const walk = (o: GlyphOutline) => {
    for (const element of o.elements) {
      if (element.kind !== "component" || seen.has(element.glyph)) continue;
      seen.add(element.glyph);
      const next = lookup(element.glyph);
      if (next) walk(next);
    }
  };
  walk(outline);
  return [...seen];
}

/** Replace one component instance with its transformed contours; null if it is not an instance. */
export function expandComponent(
  outline: GlyphOutline,
  index: number,
  lookup: GlyphLookup,
): GlyphOutline | null {
  const element = outline.elements[index];
  if (!element || element.kind !== "component") return null;
  const contours = resolveComponent(element, lookup, []);
  return {
    ...outline,
    elements: [
      ...outline.elements.slice(0, index),
      ...contours.map((c) => ({ kind: "contour" as const, ...c })),
      ...outline.elements.slice(index + 1),
    ],
  };
}
