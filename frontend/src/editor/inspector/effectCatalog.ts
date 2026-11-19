/**
 * The effect catalog (Part B SPEC §23.8): a label, a one-line description and a
 * category for every effect id. The picker is built from it; labels here are the
 * fallback when a pass isn't registered in this build (`postDef(id)` undefined).
 */
import type { PostType } from "@/viz/types";

export const EFFECT_CATEGORIES = ["Camera & motion", "Blur & glow", "Distort", "Stylize", "Colour & light", "Key", "Depth", "Glitch"] as const;
export type EffectCategory = (typeof EFFECT_CATEGORIES)[number];

export interface EffectInfo {
  label: string;
  description: string;
  category: EffectCategory;
}

export const EFFECT_CATALOG: Record<PostType, EffectInfo> = {
  // Camera & motion
  punch: { label: "Zoom punch", description: "A quick zoom in that snaps back; made for kicks.", category: "Camera & motion" },
  shake: { label: "Camera shake", description: "Shakes the frame, harder on each hit.", category: "Camera & motion" },
  zoompulse: { label: "Zoom pulse", description: "A gentle zoom that breathes with the beat.", category: "Camera & motion" },
  swing: { label: "3D swing", description: "Tilts the picture in 3D around its centre.", category: "Camera & motion" },
  // Blur & glow
  blurpulse: { label: "Blur pulse", description: "A soft blur that flares up and fades.", category: "Blur & glow" },
  zoomblur: { label: "Zoom blur", description: "Radial streaks rushing towards a point.", category: "Blur & glow" },
  dirblur: { label: "Motion blur", description: "Blurs along a direction, like a fast pan.", category: "Blur & glow" },
  glow: { label: "Deep glow", description: "Bright parts bloom into a wide soft halo.", category: "Blur & glow" },
  bloom: { label: "Bloom", description: "A soft glow on the brightest areas (whole edit only).", category: "Blur & glow" },
  // Distort
  twirl: { label: "Twirl", description: "Swirls the picture around a point.", category: "Distort" },
  wave: { label: "Wave", description: "Ripples the picture like water.", category: "Distort" },
  bulge: { label: "Bulge / pinch", description: "Pushes the picture out of, or into, a point.", category: "Distort" },
  shockwave: { label: "Shockwave", description: "A ring that bends the picture as it spreads.", category: "Distort" },
  kaleido: { label: "Kaleidoscope", description: "Repeats a wedge of the picture in a circle.", category: "Distort" },
  mirror: { label: "Mirror / kaleidoscope", description: "Mirrored segments that slowly spin.", category: "Distort" },
  // Stylize
  pixelate: { label: "Pixelate", description: "Big square pixels.", category: "Stylize" },
  halftone: { label: "Halftone", description: "Printed dots, like comics and manga.", category: "Stylize" },
  posterize: { label: "Posterize", description: "Fewer colour levels for a flat, graphic look.", category: "Stylize" },
  mono: { label: "Black and white", description: "Greys, or hard black and white for manga frames.", category: "Stylize" },
  vhs: { label: "VHS", description: "Tape wobble, colour bleed, scanlines and noise.", category: "Stylize" },
  letterbox: { label: "Letterbox", description: "Cinema bars at the top and bottom.", category: "Stylize" },
  speedlines: { label: "Speed lines", description: "Anime lines radiating from a point.", category: "Stylize" },
  sharpen: { label: "Sharpen", description: "Crisper edges and fine detail.", category: "Stylize" },
  outline: { label: "Ink outline", description: "Draws the edges as ink, or as neon.", category: "Stylize" },
  vignette: { label: "Vignette", description: "Darkens the corners (whole edit only).", category: "Stylize" },
  grain: { label: "Film grain", description: "Fine film noise (whole edit only).", category: "Stylize" },
  // Colour & light
  grade: { label: "Colour grade", description: "Lift, gamma, gain, saturation and warmth.", category: "Colour & light" },
  flash: { label: "Flash", description: "A white flash that fades; made for drops.", category: "Colour & light" },
  exposure: { label: "Exposure pulse", description: "A brightness pop that fades.", category: "Colour & light" },
  invert: { label: "Invert", description: "Flips the colours to negative.", category: "Colour & light" },
  duotone: { label: "Duotone", description: "Maps the picture onto two colours.", category: "Colour & light" },
  colorpop: { label: "Colour pop", description: "Keeps one colour and greys the rest.", category: "Colour & light" },
  lightleak: { label: "Light leak", description: "Warm blobs of light drifting over the picture.", category: "Colour & light" },
  halation: { label: "Halation", description: "A red-orange film glow around bright edges.", category: "Colour & light" },
  gradelook: { label: "Color Grader look", description: "A whole Color Grader look: its colour chain in one pass.", category: "Colour & light" },
  edgeglow: { label: "Edge glow", description: "Neon light along the edges.", category: "Stylize" },
  // Key (Phase 21)
  chromakey: { label: "Chroma key", description: "Makes a green or blue screen transparent.", category: "Key" },
  lumakey: { label: "Luma key", description: "Makes dark (or bright) parts transparent.", category: "Key" },
  // Depth (Phase 21; needs a depth map)
  depthfog: { label: "Depth fog", description: "Coloured fog that thickens with distance.", category: "Depth" },
  tiltshift: { label: "Depth blur", description: "Keeps one distance sharp and blurs the rest.", category: "Depth" },
  // Glitch
  chromatic: { label: "Chromatic aberration", description: "Splits the red, green and blue channels apart.", category: "Glitch" },
  glitch: { label: "Glitch", description: "Torn blocks, shifted lines and colour splits.", category: "Glitch" },
  slice: { label: "Slice shift", description: "Horizontal bands that slide sideways.", category: "Glitch" },
  // Never offered (stateful)
  feedback: { label: "Feedback", description: "Trails from the previous frame (not available in edits).", category: "Glitch" },
};

export function effectInfo(type: PostType): EffectInfo {
  return EFFECT_CATALOG[type];
}
