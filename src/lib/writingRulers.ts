//! Ruler maths: the adaptive tick ladder for the canvas rulers, pure so it
//! can be tested and mutation-checked without the DOM.

/** Thickness of a ruler strip, in screen pixels. */
export const RULER_PX = 18;
/** How close a pointer must be to grab a guide line, in screen pixels. */
export const GUIDE_HIT_PX = 6;
/** Majors (the labelled ticks) stay at least this far apart on screen. */
export const MAJOR_MIN_PX = 48;

export interface Tick {
  /** Position in font units. */
  at: number;
  /** Label text for a major tick; null for a minor. */
  label: string | null;
}

/**
 * The ticks for a ruler spanning font units `[from, to]` at
 * `pxPerUnit` screen pixels per unit: majors on a 1/2/5 ladder chosen as the
 * finest step whose spacing still clears [`MAJOR_MIN_PX`], minors at a fifth
 * of it (which the ladder already keeps at least ~9.6 px apart). Labels carry
 * no trailing zeros, so a zoomed-out ruler reads 0, 500, 1000, not 0.0, 500.0.
 */
export function rulerTicks(from: number, to: number, pxPerUnit: number): Tick[] {
  const span = to - from;
  if (!(span > 0) || !(pxPerUnit > 0)) return [];
  const raw = MAJOR_MIN_PX / pxPerUnit;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = power;
  for (const k of [1, 2, 5, 10]) {
    if (power * k >= raw) {
      step = power * k;
      break;
    }
  }
  const decimals = step >= 1 ? 0 : Math.ceil(-Math.log10(step));
  const minor = step / 5;
  const ticks: Tick[] = [];
  const first = Math.ceil(from / minor) * minor;
  const last = Math.floor(to / minor) * minor;
  for (let at = first; at <= last + minor / 2; at += minor) {
    const rounded = Number(at.toFixed(6));
    const isMajor = Math.abs(rounded / step - Math.round(rounded / step)) < 1e-6;
    ticks.push(isMajor ? { at: rounded, label: rounded.toFixed(decimals) } : { at: rounded, label: null });
  }
  return ticks;
}
