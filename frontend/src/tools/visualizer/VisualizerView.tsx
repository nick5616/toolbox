/**
 * Visualizer (SPEC.md §8): Source → Analyze → Design → Export.
 *
 * Keeps in module state: `visualizer` (the analysis key per input path and the
 * export options) and `visualizer.lastShow` (the design, so it survives a
 * restart). `?vizfixture=1` (TOOLBOX_VIZ_FIXTURE=1) jumps to Design with the
 * synthetic analysis so the designer can be tried without the engine.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Icon, Spinner, cx } from "@/components";
import { SettingsService, type AnalysisRef } from "@/lib/api";
import { buildFixture } from "@/viz/fixture";
import { validateShow } from "@/viz/validate";
import type { Show } from "@/viz/types";
import type { ToolViewProps } from "../index";
import { MAX_STATE_BYTES, patchVizState, readVizState } from "./vizState";
import { DEFAULT_EXPORT, sanitizeExport, type ExportPrefs } from "./exportPrefs";
import { useSeed } from "./useSeed";
import { useVisualizer, type VisualizerStep } from "./store";
import styles from "./VisualizerView.module.css";

const SourceStep = lazy(() => import("./SourceStep"));
const AnalyzeStep = lazy(() => import("./AnalyzeStep"));
const DesignStep = lazy(() => import("./DesignStep"));
const ExportStep = lazy(() => import("./ExportStep"));

const STEPS: Array<{ id: VisualizerStep; label: string }> = [
  { id: "source", label: "Source" },
  { id: "analyze", label: "Analyze" },
  { id: "design", label: "Design" },
  { id: "export", label: "Export" },
];

export const LAST_SHOW_KEY = "visualizer.lastShow";
const MAX_KEYS = 50;

interface Prefs {
  /** Analysis key by input path (most recent last). */
  analysisKeys: Record<string, string>;
  export: ExportPrefs;
}
const DEFAULT_PREFS: Prefs = { analysisKeys: {}, export: DEFAULT_EXPORT };

export function sanitizePrefs(raw: unknown, d: Prefs): Prefs {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const keys: Record<string, string> = {};
  if (typeof o.analysisKeys === "object" && o.analysisKeys !== null) {
    for (const [k, v] of Object.entries(o.analysisKeys as Record<string, unknown>).slice(-MAX_KEYS)) if (typeof v === "string") keys[k] = v;
  }
  return { analysisKeys: keys, export: o.export ? sanitizeExport(o.export) : d.export };
}

export const FIXTURE_INPUT = "fixture-song.mp3";

function fixtureRef(durationMs: number): AnalysisRef {
  return {
    key: "fixture",
    audioJson: "",
    featuresPath: "",
    textJson: "",
    instrumental: "",
    summary: { durationMs, tempo: 120, key: "A minor", sections: ["intro", "verse", "chorus", "drop", "outro"], hasStems: true, hasWords: true, hasMeaning: true, moodSource: "music", language: "en", lines: 8, warnings: null },
  };
}

/** The view's remembered options, merged into the shared "visualizer" module state (other keys are left alone). */
function usePrefs(): [Prefs, (next: Prefs | ((p: Prefs) => Prefs)) => void] {
  const [prefs, setState] = useState<Prefs>(DEFAULT_PREFS);
  const dirty = useRef(false);
  useEffect(() => {
    let off = false;
    void readVizState().then((st) => {
      if (!off && !dirty.current) setState(sanitizePrefs(st, DEFAULT_PREFS));
    });
    return () => {
      off = true;
    };
  }, []);
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => void patchVizState({ analysisKeys: prefs.analysisKeys, export: prefs.export }), 300);
    return () => clearTimeout(t);
  }, [prefs]);
  const set = useCallback((next: Prefs | ((p: Prefs) => Prefs)) => {
    dirty.current = true;
    setState(next);
  }, []);
  return [prefs, set];
}

function Loading() {
  return (
    <div className={styles.loading}>
      <Spinner size={18} label="Loading" />
    </div>
  );
}

export default function VisualizerView({ moduleId }: ToolViewProps) {
  const [prefs, setPrefs] = usePrefs();
  const step = useVisualizer((s) => s.step);
  const input = useVisualizer((s) => s.input);
  const ref = useVisualizer((s) => s.ref);
  const show = useVisualizer((s) => s.show);
  const setStep = useVisualizer((s) => s.setStep);
  const [lastShow, setLastShow] = useState<Show | null>(null);
  const [lastLoaded, setLastLoaded] = useState(false);
  const fixtureDone = useRef(false);

  useSeed(moduleId);

  // ---- the design survives a restart ----
  useEffect(() => {
    let off = false;
    SettingsService.ModuleState(LAST_SHOW_KEY)
      .then((raw) => {
        if (off || !raw) return;
        const v = validateShow(JSON.parse(raw) as unknown);
        if (v.ok) setLastShow(v.show);
      })
      .catch(() => undefined)
      .finally(() => !off && setLastLoaded(true));
    return () => {
      off = true;
    };
  }, []);

  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => {
      const json = JSON.stringify(show);
      if (json.length <= MAX_STATE_BYTES) SettingsService.SetModuleState(LAST_SHOW_KEY, json).catch(() => undefined);
    }, 600);
    return () => clearTimeout(t);
  }, [show]);

  // ---- the analysis key of each input is remembered ----
  useEffect(() => {
    if (!input || !ref || ref.key === "fixture") return;
    if (prefs.analysisKeys[input] === ref.key) return;
    setPrefs((p) => {
      const keys = { ...p.analysisKeys };
      delete keys[input];
      keys[input] = ref.key;
      const entries = Object.entries(keys).slice(-MAX_KEYS);
      return { ...p, analysisKeys: Object.fromEntries(entries) };
    });
  }, [input, ref, prefs.analysisKeys, setPrefs]);

  // ---- dev: the synthetic analysis ----
  useEffect(() => {
    if (fixtureDone.current || !lastLoaded) return;
    if (new URLSearchParams(window.location.search).get("vizfixture") !== "1") return;
    fixtureDone.current = true;
    const a = buildFixture();
    const s = useVisualizer.getState();
    s.setInput(FIXTURE_INPUT, false);
    s.setAnalysis(fixtureRef(a.durationMs), a);
    s.setStep("design");
  }, [lastLoaded]);

  const onPrefs = useCallback((patch: Partial<ExportPrefs>) => setPrefs((p) => ({ ...p, export: { ...p.export, ...patch } })), [setPrefs]);

  const reachable = (id: VisualizerStep): boolean => {
    switch (id) {
      case "source":
        return true;
      case "analyze":
        return !!input;
      case "design":
        return !!ref && !!input;
      case "export":
        return !!ref && !!input && !!show;
    }
  };

  return (
    <div className={styles.root}>
      <nav className={styles.steps} aria-label="Steps">
        {STEPS.map((s, i) => (
          <button key={s.id} type="button" className={cx(styles.step, step === s.id && styles.stepOn)} aria-current={step === s.id ? "step" : undefined} disabled={!reachable(s.id)} onClick={() => setStep(s.id)}>
            <span className={styles.stepNum}>{i + 1}</span>
            {s.label}
            {i < STEPS.length - 1 && <Icon name="chevron-right" size={12} className={styles.stepSep} />}
          </button>
        ))}
      </nav>
      <div className={cx(styles.body, step === "design" && styles.bodyWide)}>
        <Suspense fallback={<Loading />}>
          {step === "source" && <SourceStep onAnalyze={() => setStep("analyze")} />}
          {step === "analyze" && <AnalyzeStep onDone={() => setStep("design")} />}
          {step === "design" && (lastLoaded ? <DesignStep lastShow={lastShow} aspect={prefs.export.aspect} onExport={() => setStep("export")} onBack={() => setStep("analyze")} /> : <Loading />)}
          {step === "export" && <ExportStep prefs={prefs.export} onPrefs={onPrefs} onBack={() => setStep("design")} />}
        </Suspense>
      </div>
    </div>
  );
}
