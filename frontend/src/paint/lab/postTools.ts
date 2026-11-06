// The viz/post effects offered as painted Lab tools (SPEC 1.4.1).

import { postTool, type PostLabTool, type PostToolConfig } from "./adapter";
import { clamp } from "./common";
import type { LabParam } from "./types";

const REACH = "How big an area each dab works on, as a multiple of the brush size. Bigger reach makes the effect broader than the brush; only the brush shape is painted.";

/** sRGB colour -> the hex whose linearisation equals it (the post shaders linearise their hex colours). */
function precompensate(hex: string): string {
  const n = (i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  const enc = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const b = (v: number) => Math.round(clamp(enc(v), 0, 1) * 255).toString(16).padStart(2, "0");
  return `#${b(n(0))}${b(n(1))}${b(n(2))}`;
}

export const DUOTONE_LOOKS: Record<string, [string, string]> = {
  "ink-paper": ["#1a1a2e", "#f4ecd8"],
  "night-neon": ["#1b0436", "#ff4fd8"],
  sunset: ["#3a0f4b", "#ffb347"],
  "sea-glass": ["#0b3c49", "#bdf3e0"],
  "red-black": ["#0d0d0d", "#e8321e"],
};

const DUOTONE_EXTRA: LabParam[] = [
  {
    id: "look",
    label: "Colours",
    type: "choice",
    choices: [
      { value: "ink-paper", label: "Ink and paper" },
      { value: "night-neon", label: "Night neon" },
      { value: "sunset", label: "Sunset" },
      { value: "sea-glass", label: "Sea glass" },
      { value: "red-black", label: "Red and black" },
    ],
    default: "night-neon",
    tip: "The two colours the picture is mapped between: dark parts get the first, bright parts the second.",
  },
];

const CONFIGS: PostToolConfig[] = [
  {
    id: "kaleido",
    label: "Kaleido",
    description: "Paints a kaleidoscope: the area under each dab is folded into mirrored wedges.",
    icon: "kaleido",
    type: "kaleido",
    predictability: "exact",
    origin: "Around the centre of each dab, the area is cut into equal wedges. Every other wedge is flipped, and each pixel looks up its colour in the first wedge. Nothing is random.",
    tips: { amount: "How much of the folded picture replaces the original.", segments: "How many wedges the dab is folded into.", rotation: "Turns the wedges around the centre, in degrees.", zoom: "Magnifies the folded picture. Above 1 shows less of it, bigger.", reach: REACH },
    defaults: { amount: 1, segments: 6 },
  },
  {
    id: "mirror",
    label: "Mirror",
    description: "Paints mirrored copies of what is under each dab.",
    icon: "mirror",
    type: "mirror",
    predictability: "exact",
    origin: "Like the kaleidoscope, but folded with reflections at the edges of the dab area. Each pixel looks up its colour in a mirrored copy of the picture. Nothing is random.",
    tips: { segments: "How many mirrored slices the dab is cut into.", zoom: "Magnifies the mirrored picture.", mix: "How much of the mirrored picture replaces the original.", reach: REACH },
    fixed: { spin: 0 },
    labels: { mix: "Amount" },
  },
  {
    id: "twirl",
    label: "Twirl",
    description: "Swirls the picture under each dab around its centre.",
    icon: "twirl",
    type: "twirl",
    predictability: "exact",
    origin: "Each pixel inside the dab area is rotated around the centre by an angle that is largest at the middle and fades to zero at the edge, so the picture winds up like water going down a drain. Negative amounts wind the other way.",
    tips: { amount: "How many turns the centre makes. Negative swirls the other way.", radius: "How much of the dab area swirls, from the centre out.", reach: REACH },
    defaults: { amount: 0.35, radius: 0.5 },
    fixed: { cx: 0.5, cy: 0.5 },
  },
  {
    id: "bulge",
    label: "Bulge / pinch",
    description: "Magnifies the picture under each dab, or pinches it inward.",
    icon: "bulge",
    type: "bulge",
    predictability: "exact",
    origin: "Pixels near the centre of each dab look up their colour from closer to the centre (a bulge) or farther from it (a pinch). The effect fades smoothly to nothing at the edge. Nothing is random.",
    tips: { amount: "Positive bulges outward, negative pinches inward.", radius: "How much of the dab area is bent, from the centre out.", reach: REACH },
    defaults: { amount: 0.7, radius: 0.5 },
    fixed: { cx: 0.5, cy: 0.5 },
  },
  {
    id: "wave",
    label: "Wave",
    description: "Ripples the picture under each dab like a flag.",
    icon: "wave",
    type: "wave",
    predictability: "exact",
    origin: "Each pixel looks up its colour a little above or below where it is, by an amount that follows a sine wave across the dab. Nothing is random and nothing moves.",
    tips: { amount: "How tall the ripples are.", freq: "How many ripples fit across the dab area.", dir: "Whether ripples run left to right or top to bottom.", reach: REACH },
    defaults: { amount: 0.6, freq: 3 },
    ranges: { freq: { min: 0.5, max: 12 } },
    fixed: { speed: 0 },
  },
  {
    id: "glitch",
    label: "Glitch slice",
    description: "Tears the picture into shifted, colour-split slices.",
    icon: "glitch",
    type: "glitch",
    predictability: "seeded",
    origin: "Bands of the picture are shifted sideways by random amounts and the colour channels are pulled apart. The random numbers come from the seed and each dab's place in the stroke, so locking the seed repeats the glitch exactly.",
    tips: { amount: "How violent the tearing is.", reach: REACH },
    defaults: { amount: 0.8 },
    fixed: { trigger: "amount" },
    seededTime: true,
  },
  {
    id: "chromatic",
    label: "Chromatic split",
    description: "Pulls the red and blue channels apart, like a cheap lens.",
    icon: "chromatic",
    type: "chromatic",
    predictability: "exact",
    origin: "The red channel is read from a point a few pixels one way and the blue channel from the opposite way, growing toward the edge of the dab. Green stays put, which leaves coloured fringes on edges.",
    tips: { amount: "How far apart the colours are pulled, in pixels at the edge of the dab.", reach: REACH },
    defaults: { amount: 6 },
    fixed: { source: "amount" },
  },
  {
    id: "vhs",
    label: "VHS",
    description: "Scanlines, smeared colour and wobble, like worn videotape.",
    icon: "vhs",
    type: "vhs",
    predictability: "exact",
    origin: "Dark scanlines are laid across the area, colour is smeared sideways, lines wobble a little, and fixed noise is added. The noise is a formula of position, not random numbers.",
    tips: { amount: "How much of the tape look replaces the original.", scanlines: "Strength of the dark horizontal lines.", bleed: "How far colours smear sideways.", wobble: "How much lines wander left and right.", noise: "How much speckle is added.", reach: REACH },
    defaults: { amount: 0.85 },
  },
  {
    id: "pixelate",
    label: "Pixelate",
    description: "Turns the picture under each dab into chunky square blocks.",
    icon: "pixelate",
    type: "pixelate",
    predictability: "exact",
    origin: "The dab area is cut into a grid of squares, and every square takes the colour found at its centre.",
    tips: { amount: "Block size: higher is chunkier.", reach: REACH },
    defaults: { amount: 0.7 },
  },
  {
    id: "halftone",
    label: "Halftone",
    description: "Redraws the picture as printed dots.",
    icon: "halftone",
    type: "halftone",
    predictability: "exact",
    origin: "The area is cut into a tilted grid. In each cell a round dot is drawn whose size follows how dark the picture is there, like a newspaper photo.",
    tips: { amount: "How much of the dot pattern replaces the original.", dots: "How many dots fit across the dab area.", angle: "Tilt of the dot grid, in degrees.", mode: "Black dots only, or dots in the picture's own colours.", reach: REACH },
    defaults: { amount: 1, dots: 14 },
    ranges: { dots: { min: 4, max: 60 } },
  },
  {
    id: "posterize",
    label: "Posterize",
    description: "Reduces the picture under each dab to a few flat colour levels.",
    icon: "posterize",
    type: "posterize",
    predictability: "exact",
    origin: "Each colour channel is rounded to the nearest of a few evenly spaced levels, which flattens smooth gradients into bands.",
    tips: { amount: "How much of the flattened picture replaces the original.", levels: "How many levels each colour channel keeps. Fewer is flatter.", reach: REACH },
    defaults: { amount: 1, levels: 4 },
  },
  {
    id: "duotone",
    label: "Duotone",
    description: "Recolours the picture under each dab with just two colours.",
    icon: "duotone",
    type: "duotone",
    predictability: "exact",
    origin: "Each pixel's brightness is worked out, then replaced by a colour between your two choices: the dark colour for dark pixels, the light colour for bright ones.",
    tips: { amount: "How much of the two-colour version replaces the original.", reach: REACH },
    defaults: { amount: 1 },
    extra: DUOTONE_EXTRA,
    toPost: (lab) => {
      const pair = DUOTONE_LOOKS[String(lab.look ?? "night-neon")] ?? (DUOTONE_LOOKS["night-neon"] as [string, string]);
      return { shadows: precompensate(pair[0]), highlights: precompensate(pair[1]) };
    },
  },
];

export const POST_TOOLS: PostLabTool[] = CONFIGS.map((c) => postTool(c));
