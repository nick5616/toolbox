/** Visuals for the burn (SPEC.md 9.3): helpers and small hooks shared by the Export step and the designer sheet. */
import { useEffect, useMemo, useState } from "react";
import { FilesService, VisualizerService, type AnalyzeOptions, type TimedLine, type VisualsSpec } from "@/lib/api";
import { loadRef, fixtureFlag } from "@/components/viz/useVisualsAnalysis";
import { pickerAnalyzeOptions, presetItems } from "@/components/viz/pickerModel";
import type { ToolSeed } from "@/state/ui";
import { Analysis } from "@/viz/analysis";
import { buildFixture } from "@/viz/fixture";
import type { CueRow } from "./logic";
import type { Prefs } from "./options";

/** The cues as timed lines (words included when the cue has them). */
export function cuesToLines(rows: readonly CueRow[]): TimedLine[] {
  return rows.map((r) => ({
    startMs: r.startMs,
    endMs: r.endMs,
    text: r.text,
    words: (r.words ?? []).map((w) => ({ startMs: w.startMs, endMs: w.endMs, text: w.text })),
  }));
}

/** The design a new burn starts from: the first card of the picker (overlay presets first over a video). */
export function defaultVisuals(mode: "background" | "overlay"): VisualsSpec | null {
  const first = presetItems(mode)[0];
  return first ? { showJson: JSON.stringify(first.show), stems: false, useWords: true } : null;
}

/** Whether the mood reader is installed (the picker asks the same question). */
export function useMoodReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    VisualizerService.MoodReaderReady()
      .then((ok) => alive && setReady(Boolean(ok)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

/** The analyze options the picker and the designer share for this file's cues. */
export function useAnalyzeOptions(spec: VisualsSpec | null, lines: TimedLine[]): AnalyzeOptions {
  const moodReady = useMoodReady();
  return useMemo(
    () => pickerAnalyzeOptions({ stems: spec?.stems ?? false, useWords: (spec?.useWords ?? true) && lines.length > 0, lines, moodReady }),
    [spec?.stems, spec?.useWords, lines, moodReady],
  );
}

const POLL_MS = 3000;

/**
 * Picks up the analysis the picker makes (it submits the job): looks in the
 * cache now and then until one is there. Never submits anything itself.
 */
export function useCachedAnalysis(path: string | null, stems: boolean, enabled: boolean): Analysis | null {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  useEffect(() => {
    setAnalysis(null);
    if (!enabled) return;
    if (fixtureFlag()) {
      setAnalysis(buildFixture());
      return;
    }
    if (!path) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      try {
        const [ref, ok] = await VisualizerService.AnalysisFor(path, stems);
        if (ok && alive) {
          const a = await loadRef(ref);
          if (alive) setAnalysis(a);
          return;
        }
      } catch {
        /* try again */
      }
      if (alive) timer = setTimeout(() => void look(), POLL_MS);
    };
    void look();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [path, stems, enabled]);
  return analysis;
}

/** A small data URL for a picked background image. */
export function useImageThumb(path: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!enabled || !path) return;
    let alive = true;
    FilesService.ImageThumb(path, 640)
      .then((u) => alive && setUrl(u))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path, enabled]);
  return url;
}

/** The seed for "Make it fully reactive in Visualizer" (SPEC.md 9.4, 9.5). */
export function handoffSeed(lines: TimedLine[], overlay: boolean, prefs: Prefs): ToolSeed {
  return {
    kind: "timed-text",
    from: "subtitles",
    lines,
    overlay,
    look: {
      font: prefs.font,
      textColor: prefs.style === "yellow" ? "#ffe14d" : "#ffffff",
      highlightColor: "#ffe14d",
      karaoke: false,
      position: "lower",
    },
  };
}
