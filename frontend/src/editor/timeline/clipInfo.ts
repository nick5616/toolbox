/** Pure helpers for how a clip is drawn (Phase 9 SPEC §14.5). */
import type { CSSProperties } from "react";
import type { EditClip, EditSourceState } from "@/lib/api";
import { speedAt } from "@/editor/doc";
import { parseTextClip, parseVisualClip } from "@/viz/edit/schema";
import { visualLabel } from "../visual/visualInfo";

export type ClipStatus = "ok" | "missing" | "preparing";

/**
 * Missing: the source file can't be read; preparing: its edit stream or image
 * is being made. Unknown (state not loaded yet) draws as ok.
 */
export function clipStatus(clip: Pick<EditClip, "kind" | "path">, state: EditSourceState | undefined): ClipStatus {
  if (clip.kind !== "video" && clip.kind !== "image") return "ok";
  if (!state) return "ok";
  if (state.info.error || state.info.kind === "") return "missing";
  if (state.preparing) return "preparing";
  const ready = clip.kind === "video" ? !!state.preview : state.image !== "";
  return ready ? "ok" : state.error ? "missing" : "preparing";
}

/** True when the clip's speed isn't a plain 1. */
export function hasSpeedChange(clip: Pick<EditClip, "speed">): boolean {
  return clip.speed !== "" && clip.speed !== "1";
}

/** A short label: the file name, "Colour" or "Adjustment". */
export function clipLabel(clip: Pick<EditClip, "kind" | "path"> & Partial<Pick<EditClip, "text" | "visual">>): string {
  if (clip.kind === "color") return "Colour";
  if (clip.kind === "adjust") return "Adjustment";
  if (clip.kind === "text") {
    const t = parseTextClip(clip.text ?? "").value.text.replace(/\s+/g, " ").trim();
    return t ? `“${t.slice(0, 40)}”` : "Text";
  }
  if (clip.kind === "visual") return visualLabel(parseVisualClip(clip.visual ?? "").value.layer);
  return clip.path.split(/[\\/]/).pop() ?? clip.path;
}

/** Where in the filmstrip sprite (the whole source) the part [fromMs, toMs) of the source sits. */
export function stripStyle(fromMs: number, toMs: number, sourceMs: number): CSSProperties {
  const len = toMs - fromMs;
  if (sourceMs <= 0 || len <= 0 || len >= sourceMs) return { backgroundSize: "100% 100%", backgroundPosition: "0 0" };
  const pos = sourceMs - len > 0 ? (fromMs / (sourceMs - len)) * 100 : 0;
  return { backgroundSize: `${(sourceMs / len) * 100}% 100%`, backgroundPosition: `${Math.max(0, Math.min(100, pos))}% 0` };
}

/** The source range a video clip shows (speed-aware, on the clip's own timeline). */
export function sourceWindow(clip: EditClip, fps: number): { fromMs: number; toMs: number } {
  if (!hasSpeedChange(clip)) return { fromMs: clip.inMs, toMs: clip.inMs + (clip.endMs - clip.startMs) };
  const step = 1000 / fps;
  const len = clip.endMs - clip.startMs;
  let src = clip.inMs;
  for (let u = 0; u < len; u += step) src += speedAt(clip, u) * Math.min(step, len - u);
  return { fromMs: clip.inMs, toMs: Math.round(src) };
}
