/** Visuals for the burn (SPEC.md 9.3): helpers and small hooks shared by the Export step and the designer sheet. */
import { useEffect, useMemo, useRef, useState } from "react";
import { FilesService, JobStatus, VisualizerService, type AnalyzeOptions, type TimedLine, type VisualsSpec } from "@/lib/api";
import { loadRef, fixtureFlag } from "@/components/viz/useVisualsAnalysis";
import { pickerAnalyzeOptions, presetItems } from "@/components/viz/pickerModel";
import { useJobs } from "@/state/jobs";
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

const VISUALIZER_MODULE = "visualizer";

/** How many Visualizer jobs have finished (the signal that an analysis may now exist). */
function useFinishedAnalyses(): number {
  return useJobs((s) => {
    let n = 0;
    for (const j of Object.values(s.byId)) if (j.moduleId === VISUALIZER_MODULE && j.status === JobStatus.JobDone) n++;
    return n;
  });
}

/**
 * Picks up the analysis the picker makes (it submits the job): looks in the
 * cache once, then again whenever a Visualizer job finishes. Never polls and
 * never submits anything itself.
 */
export function useCachedAnalysis(path: string | null, stems: boolean, enabled: boolean): Analysis | null {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const found = useRef(false);
  const finished = useFinishedAnalyses();
  useEffect(() => {
    found.current = false;
    setAnalysis(null);
  }, [path, stems, enabled]);
  useEffect(() => {
    if (!enabled || found.current) return;
    if (fixtureFlag()) {
      found.current = true;
      setAnalysis(buildFixture());
      return;
    }
    if (!path) return;
    let alive = true;
    void (async () => {
      try {
        const [ref, ok] = await VisualizerService.AnalysisFor(path, stems);
        if (!ok || !alive) return;
        const a = await loadRef(ref);
        if (alive && !found.current) {
          found.current = true;
          setAnalysis(a);
        }
      } catch {
        /* the next finished analysis checks again */
      }
    })();
    return () => {
      alive = false;
    };
  }, [path, stems, enabled, finished]);
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
