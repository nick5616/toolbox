/**
 * What the selection bar's chips say about a clip's constituents (Phase 10
 * SPEC §5.5): one muted line each, so nothing is hidden silently.
 */
import type { EditClip, EditMatteState } from "@/lib/api";
import { parseEffects, parseMasks, parseSpeed, parseTextClip, parseTransform, parseTransition, parseVisualClip } from "@/viz/edit/schema";
import { isKeyed, paramBase } from "../inspector/paramOps";
import { TRANSITION_LABELS } from "../inspector/TransitionField";
import { visualLabel } from "../visual/visualInfo";

export interface ChipDef {
  /** Registered panel id. */
  panel: string;
  /** Clip kinds that show the chip. */
  kinds: ReadonlyArray<EditClip["kind"]>;
}

/** The editor's own clip chips in bar order. */
export const CLIP_CHIPS: readonly ChipDef[] = [
  { panel: "clip-text-style", kinds: ["text"] },
  { panel: "clip-visual", kinds: ["visual"] },
  { panel: "clip-transform", kinds: ["video", "image", "color", "text", "visual", "adjust"] },
  { panel: "clip-speed", kinds: ["video"] },
  { panel: "clip-effects", kinds: ["video", "image", "color", "text", "visual", "adjust"] },
  { panel: "clip-masks", kinds: ["video", "image", "color", "text", "visual", "adjust"] },
  { panel: "clip-cutout", kinds: ["video", "image"] },
  { panel: "clip-transition", kinds: ["video", "image", "color", "text", "visual"] },
];

const plural = (n: number, one: string): string => (n === 0 ? "None" : `${n} ${one}${n === 1 ? "" : "s"}`);

export interface SummaryCtx {
  mattes: Record<string, EditMatteState>;
}

/** The muted summary of one of the editor's own clip panels for `clip`. */
export function clipSummary(panel: string, clip: EditClip, ctx: SummaryCtx): string {
  switch (panel) {
    case "clip-transform": {
      if (clip.kind === "adjust") return `${Math.round(Number(paramBase(parseTransform(clip.transform).value.opacity)) * 100)}%`;
      if (clip.transform === "") return "Default";
      const t = parseTransform(clip.transform).value;
      return isKeyed(t.x) || isKeyed(t.y) || isKeyed(t.scale) || isKeyed(t.rotation) || isKeyed(t.opacity) ? "Animated" : "Adjusted";
    }
    case "clip-effects":
      return plural(parseEffects(clip.effects).value.length, "effect");
    case "clip-masks":
      return plural(parseMasks(clip.masks).value.length, "mask");
    case "clip-cutout": {
      if (!clip.matte) return "None";
      return ctx.mattes[clip.matte.id]?.ready ? "Cut-out ready" : "Making…";
    }
    case "clip-speed": {
      const speed = parseSpeed(clip.speed).value;
      if (isKeyed(speed)) return "Ramp";
      const v = paramBase(speed);
      const base = v === 1 ? "Normal" : `${(Math.round(v * 100) / 100).toString()}×`;
      return clip.slow === "interpolate" ? `${base}, smooth` : base;
    }
    case "clip-transition": {
      const t = parseTransition(clip.in).value;
      return t.kind === "cut" ? "Cut" : `${TRANSITION_LABELS[t.kind]} ${t.ms} ms`;
    }
    case "clip-text-style": {
      const t = parseTextClip(clip.text).value;
      return t.reveal === "all" ? t.style.font || "Style" : t.reveal === "words" ? "Word by word" : "On the beat";
    }
    case "clip-visual":
      return visualLabel(parseVisualClip(clip.visual).value.layer);
    default:
      return "";
  }
}
