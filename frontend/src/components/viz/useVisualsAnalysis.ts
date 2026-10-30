/**
 * Finds or makes the analysis of a file and loads it (SPEC.md §9.1, §9.4).
 * It checks VisualizerService.AnalysisFor first; when `auto` is set and none
 * matches, it submits a `visualizer` analyze job and follows it through the
 * jobs store.
 *
 * Re-analysis rule: a cached analysis is "enough" unless the options ask for
 * words and it has none. Each distinct option set is submitted at most once
 * automatically (so a missing mood reader can never loop); `start()` always
 * submits.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  JobStatus,
  JobsService,
  MediaService,
  VisualizerAction,
  VisualizerService,
  WordsSource,
  type AnalysisRef,
  type AnalyzeOptions,
} from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { useJob } from "@/state/jobs";
import { Analysis, loadAnalysis } from "@/viz/analysis";
import { buildFixture } from "@/viz/fixture";

export interface VisualsAnalysisOptions {
  /** The analyze options (stems, words, mood…). */
  analyze: AnalyzeOptions;
  /** Submit the analysis by itself when no cached one matches. */
  auto: boolean;
}

export interface VisualsAnalysis {
  status: "idle" | "checking" | "running" | "ready" | "error";
  /** 0..1 while running. */
  progress: number;
  /** The engine stage text while running ("Separating instruments"…). */
  stage: string;
  ref: AnalysisRef | null;
  analysis: Analysis | null;
  error: AppErrorShape | null;
  /** Starts (or restarts) the analysis with the current options. */
  start(): void;
  /** Cancels a running analysis job. */
  cancel(): void;
}

/** True when the main window was opened with the synthetic-analysis dev flag. */
export function fixtureFlag(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("vizfixture") === "1";
  } catch {
    return false;
  }
}

const loaded = new Map<string, Analysis>();
const MAX_LOADED = 4;

/** Loads (and briefly caches) the files of a ref through the media route. */
export async function loadRef(ref: AnalysisRef): Promise<Analysis> {
  const hit = loaded.get(ref.key);
  if (hit) return hit;
  const [audioJsonUrl, featuresUrl, textJsonUrl] = await Promise.all([
    MediaService.URLFor(ref.audioJson),
    MediaService.URLFor(ref.featuresPath),
    ref.textJson ? MediaService.URLFor(ref.textJson) : Promise.resolve(""),
  ]);
  const a = await loadAnalysis({ audioJsonUrl, featuresUrl, textJsonUrl: textJsonUrl || undefined });
  loaded.set(ref.key, a);
  while (loaded.size > MAX_LOADED) {
    const first = loaded.keys().next().value;
    if (first === undefined) break;
    loaded.delete(first);
  }
  return a;
}

function wantsWords(a: AnalyzeOptions): boolean {
  return a.words !== WordsSource.$zero && a.words !== WordsSource.WordsNone;
}

function signature(a: AnalyzeOptions): string {
  return JSON.stringify([a.stems, a.saveStems, a.words, a.language, a.lyricsText, a.lyricsPath, a.lines, a.mood, a.deepRead]);
}

function refSatisfies(ref: AnalysisRef, a: AnalyzeOptions): boolean {
  if (wantsWords(a) && !ref.summary.hasWords) return false;
  if (a.saveStems && !ref.summary.hasStems) return false;
  return true;
}

function parseResultRef(json: string): AnalysisRef | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as { analysis?: AnalysisRef | null };
    return r.analysis && r.analysis.key ? r.analysis : null;
  } catch {
    return null;
  }
}

export function useVisualsAnalysis(path: string | null, opts: VisualsAnalysisOptions): VisualsAnalysis {
  const fixture = useMemo(() => fixtureFlag(), []);
  const [status, setStatus] = useState<VisualsAnalysis["status"]>("idle");
  const [ref, setRef] = useState<AnalysisRef | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<AppErrorShape | null>(null);
  const [jobId, setJobId] = useState("");
  const job = useJob(jobId);

  const { analyze, auto } = opts;
  const sig = useMemo(() => signature(analyze), [analyze]);
  const analyzeRef = useRef(analyze);
  analyzeRef.current = analyze;
  const pathRef = useRef(path);
  pathRef.current = path;
  const seq = useRef(0);
  const attempted = useRef(new Set<string>());
  const handledJob = useRef("");

  const finish = useCallback(async (r: AnalysisRef, my: number) => {
    try {
      const a = await loadRef(r);
      if (seq.current !== my) return;
      setRef(r);
      setAnalysis(a);
      setError(null);
      setStatus("ready");
    } catch (e) {
      if (seq.current !== my) return;
      setError(toAppError(e));
      setStatus("error");
    }
  }, []);

  const submit = useCallback(async (my: number) => {
    const p = pathRef.current;
    if (!p) return;
    const a = analyzeRef.current;
    attempted.current.add(signature(a));
    setError(null);
    setStatus("running");
    try {
      const defaults = await VisualizerService.Defaults();
      const jobs = await VisualizerService.Enqueue([p], { ...defaults, action: VisualizerAction.ActionAnalyze, analyze: a });
      if (seq.current !== my) return;
      const first = jobs?.[0];
      if (!first) throw new Error("The analysis could not be queued");
      handledJob.current = "";
      setJobId(first.id);
    } catch (e) {
      if (seq.current !== my) return;
      setError(toAppError(e));
      setStatus("error");
    }
  }, []);

  // Look for a cached analysis whenever the file or the options change.
  useEffect(() => {
    const my = ++seq.current;
    if (fixture) {
      setAnalysis(buildFixture());
      setRef(null);
      setStatus("ready");
      return;
    }
    if (!path) {
      setStatus("idle");
      setAnalysis(null);
      setRef(null);
      return;
    }
    setJobId("");
    setStatus("checking");
    setError(null);
    (async () => {
      let found: AnalysisRef | null = null;
      try {
        const [r, ok] = await VisualizerService.AnalysisFor(path, analyze.stems);
        if (ok) found = r;
      } catch {
        found = null;
      }
      if (seq.current !== my) return;
      const enough = found !== null && refSatisfies(found, analyze);
      if (found && (enough || !auto || attempted.current.has(sig))) {
        await finish(found, my);
        return;
      }
      if (!auto) {
        setStatus("idle");
        return;
      }
      if (found) {
        // Keep showing the older analysis while the better one is made.
        try {
          const a = await loadRef(found);
          if (seq.current === my) {
            setRef(found);
            setAnalysis(a);
          }
        } catch {
          /* the new analysis will replace it */
        }
        if (seq.current !== my) return;
      }
      await submit(my);
    })();
    // `analyze` is represented by `sig`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, sig, auto, fixture, finish, submit]);

  // Follow the job to its end.
  useEffect(() => {
    if (!job || handledJob.current === job.id) return;
    const my = seq.current;
    if (job.status === JobStatus.JobDone) {
      handledJob.current = job.id;
      const direct = parseResultRef(job.resultJson);
      if (direct) {
        void finish(direct, my);
        return;
      }
      const p = pathRef.current;
      if (!p) return;
      VisualizerService.AnalysisFor(p, analyzeRef.current.stems)
        .then(([r, ok]) => {
          if (seq.current !== my) return;
          if (ok) return finish(r, my);
          setError({ code: "internal", message: "The analysis finished but could not be found" });
          setStatus("error");
        })
        .catch((e: unknown) => {
          if (seq.current !== my) return;
          setError(toAppError(e));
          setStatus("error");
        });
    } else if (job.status === JobStatus.JobFailed) {
      handledJob.current = job.id;
      setError({ code: job.errorCode || "internal", message: job.error || "The analysis failed", hint: job.errorHint || undefined });
      setStatus("error");
    } else if (job.status === JobStatus.JobCancelled) {
      handledJob.current = job.id;
      setError({ code: "cancelled", message: "The analysis was cancelled" });
      setStatus("error");
    }
  }, [job, finish]);

  const start = useCallback(() => {
    if (fixture || !pathRef.current) return;
    const my = ++seq.current;
    void submit(my);
  }, [fixture, submit]);

  const cancel = useCallback(() => {
    if (jobId) JobsService.Cancel(jobId).catch(() => undefined);
  }, [jobId]);

  const running = status === "running" && job !== undefined;
  return {
    status,
    progress: running ? Math.max(0, job.progress) : 0,
    stage: running ? job.message : "",
    ref,
    analysis,
    error,
    start,
    cancel,
  };
}
