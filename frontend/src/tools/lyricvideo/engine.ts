/**
 * Which parts of the Lyric Video need the AI engine, and whether it's missing.
 * The module's requirement override is set by the view whenever anything needs
 * it; each panel shows its banner (and blocks its run) only when it needs it.
 */
import { useEffect } from "react";
import { setRequiresOverride, useDepsGate } from "@/tools/_kit";
import { lyricsNeedEngine, type Prefs } from "./options";
import { LYRIC_VIDEO_ID, useLyricVideo } from "./store";

export type EngineScope = "lyrics" | "visuals" | "render";

export function engineNeeded(scope: EngineScope, prefs: Prefs, lyricsPath: string): boolean {
  if (scope === "lyrics") return lyricsNeedEngine(prefs.source, lyricsPath);
  if (scope === "visuals") return prefs.visualsMode !== "classic";
  return prefs.audio === "instrumental";
}

/** The view calls this once: it publishes the requirement while anything needs the engine. */
export function useEngineRequirement(): void {
  const prefs = useLyricVideo((s) => s.prefs);
  const lyricsPath = useLyricVideo((s) => s.lyricsPath);
  const any = (["lyrics", "visuals", "render"] as const).some((s) => engineNeeded(s, prefs, lyricsPath));
  useEffect(() => {
    setRequiresOverride(LYRIC_VIDEO_ID, any ? ["ffmpeg", "ffprobe", "audio-engine"] : null);
  }, [any]);
  useEffect(() => () => setRequiresOverride(LYRIC_VIDEO_ID, null), []);
}

/** Whether `scope` needs the engine and it (or ffmpeg) is missing. */
export function useEngineGate(scope: EngineScope): { needed: boolean; blocked: boolean } {
  const prefs = useLyricVideo((s) => s.prefs);
  const lyricsPath = useLyricVideo((s) => s.lyricsPath);
  const gate = useDepsGate(LYRIC_VIDEO_ID);
  const needed = engineNeeded(scope, prefs, lyricsPath);
  return { needed, blocked: needed && gate.blocked };
}
