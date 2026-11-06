import type { CSSProperties } from "react";
import type { ValueType } from "@/pipelines/params";

// Pure look of the glowing wires: how bright, how wide, whether light flows.

export type WireVisualState = "idle" | "flow" | "done" | "failed" | "selected" | "drag" | "dim";

export type RGB = readonly [number, number, number];

export interface WireLook {
  /** Core brightness, 0..1.5. */
  bright: number;
  /** Tight halo radius in CSS pixels at zoom 1 (a wide dim one at 2.6x sits behind it). */
  glow: number;
  /** Halo strength, 0..1. */
  halo: number;
  /** Core width in CSS pixels at zoom 1. */
  core: number;
  /** A travelling bright segment. */
  flow: boolean;
  /** Slow shimmer amount, 0..1. */
  shimmer: number;
  /** Drawn in the danger colour. */
  danger: boolean;
}

/** Look of a wire in a state; with reduced motion nothing flows or shimmers. */
export function wireLook(state: WireVisualState, reduced: boolean): WireLook {
  const base: WireLook = { bright: 0.9, glow: 6, halo: 0.9, core: 2.5, flow: false, shimmer: 0.3, danger: false };
  let look: WireLook;
  switch (state) {
    case "flow":
      look = { ...base, bright: 1.05, halo: 1.1, flow: true, shimmer: 0 };
      break;
    case "done":
      look = { ...base, bright: 1, halo: 0.95, shimmer: 0 };
      break;
    case "dim":
      look = { ...base, bright: 0.4, glow: 4, halo: 0.2, shimmer: 0 };
      break;
    case "failed":
      look = { ...base, bright: 0.6, halo: 0.4, shimmer: 0, danger: true };
      break;
    case "selected":
      look = { ...base, bright: 1.3, glow: 8, halo: 1.3, core: 3.2, shimmer: 0 };
      break;
    case "drag":
      look = { ...base, bright: 1.35, glow: 9, halo: 1.4, core: 3.2, shimmer: 0 };
      break;
    default:
      look = base;
  }
  return reduced ? { ...look, flow: false, shimmer: 0 } : look;
}

/** True when any look animates (the render loop runs only then). */
export function isAnimated(looks: readonly WireLook[]): boolean {
  return looks.some((l) => l.flow || l.shimmer > 0);
}

/** "#rgb", "#rrggbb", "rgb(r, g, b)" and "rgba(...)" to 0..1 channels; null for anything else. */
export function parseColor(css: string): RGB | null {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1] ?? "";
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return [parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  return null;
}

/** A wire's colour is its value type's token: files are orange, values take their source's type. */
export type WireType = ValueType | "any";

export interface WirePalette {
  types: Record<WireType, RGB>;
  danger: RGB;
  /** Dark theme: the glow adds light; light theme: it is a subtler tint. */
  dark: boolean;
}

const FALLBACK: RGB = [0.6, 0.62, 0.68];
const TYPES: WireType[] = ["files", "file", "text", "number", "toggle", "choice", "color", "any"];

/** A value wire is thinner, calm (no flow, no shimmer) and tighter. */
export function valueWireLook(look: WireLook): WireLook {
  return { ...look, core: look.core >= 3 ? 2.2 : 1.6, glow: look.glow * 0.7, flow: false, shimmer: 0 };
}

/** Sets `--c` (the port or swatch colour) to a type's token. */
export function typeStyle(t: WireType): CSSProperties {
  return { ["--c"]: `var(--type-${t})` } as CSSProperties;
}

/** Inline style of a wire's SVG stroke (the fallback when WebGL isn't there, and what tests can read). */
export function svgWireStyle(type: WireType, value: boolean, dashed: boolean, failed: boolean): CSSProperties {
  const s: CSSProperties = {};
  if (!failed) s.stroke = `var(--type-${type})`;
  if (value) s.strokeWidth = 1.6;
  if (dashed) s.strokeDasharray = "5 4";
  return s;
}

/** The look of a wire of the given channel. */
export function lookFor(state: WireVisualState, reduced: boolean, value: boolean): WireLook {
  const look = wireLook(state, reduced);
  return value ? valueWireLook(look) : look;
}

/** Colours from the CSS tokens (`--type-<type>`, `--wire-failed`, `--wire-bg` on `el`). */
/** Pushes a colour away from grey so glows read as colour, not white. */
export function saturate(c: RGB, k: number): RGB {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const f = (v: number) => Math.max(0, Math.min(1, l + (v - l) * k));
  return [f(c[0]), f(c[1]), f(c[2])];
}

export function readPalette(el: Element): WirePalette {
  const cs = getComputedStyle(el);
  const get = (name: string): RGB => parseColor(cs.getPropertyValue(name)) ?? FALLBACK;
  const bg = get("--wire-bg");
  const luma = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
  const dark = luma < 0.5;
  const k = dark ? 1.5 : 1.15;
  const types = Object.fromEntries(TYPES.map((n) => [n, saturate(get(`--type-${n}`), k)])) as Record<WireType, RGB>;
  return { types, danger: saturate(get("--wire-failed"), k), dark };
}
