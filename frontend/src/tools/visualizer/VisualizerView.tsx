/**
 * Visualizer (SPEC.md §8; Phase 11 §5.5): a drop zone until a song or video is
 * chosen, then one workspace (`VisualizerWorkspace`): source chip, design name,
 * undo/redo and Export in the header, the Analysis panel in the rail, the
 * designer on the stage (or the analysis progress while there is no analysis).
 *
 * Keeps in module state: `visualizer` (the analysis key per input path and the
 * export options) and `visualizer.lastShow` (the design, so it survives a
 * restart). `?vizfixture=1` (TOOLBOX_VIZ_FIXTURE=1) opens with the synthetic
 * analysis so the designer can be tried without the engine.
 */
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { ClickInHost, Spinner } from "@/components";
import { SettingsService, type AnalysisRef } from "@/lib/api";
import { useToolHandoff } from "@/lib/embed";
import { useCompositionInputs } from "@/state/composition";
import { buildFixture } from "@/viz/fixture";
import { validateShow } from "@/viz/validate";
import type { Show } from "@/viz/types";
import type { ToolViewProps } from "../index";
import { MAX_STATE_BYTES, patchVizState, readVizState } from "./vizState";
import { DEFAULT_EXPORT, sanitizeExport, type ExportPrefs } from "./exportPrefs";
import { EmptySource } from "./SourcePanel";
import { applyHandoff } from "./useSeed";
import { useVisualizer } from "./store";
import { visualizerWorkspace as ws } from "./workspace";
import styles from "./VisualizerView.module.css";

const VisualizerWorkspace = lazy(() => import("./VisualizerWorkspace"));

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

/**
 * The remembered options, merged into the shared "visualizer" module state
 * (other keys are left alone). The export options live in the store (the
 * Export panel edits them there); the analysis keys are the view's.
 */
function usePrefs(): void {
  const [keys, setKeys] = useState<Record<string, string>>(DEFAULT_PREFS.analysisKeys);
  const keysDirty = useRef(false);
  const exportPrefs = useVisualizer((s) => s.exportPrefs);
  const baseline = useRef<ExportPrefs>(DEFAULT_EXPORT);
  const loaded = useRef(false);
  const input = useVisualizer((s) => s.input);
  const ref = useVisualizer((s) => s.ref);

  useEffect(() => {
    let off = false;
    void readVizState().then((st) => {
      if (off) return;
      const p = sanitizePrefs(st, DEFAULT_PREFS);
      if (!keysDirty.current) setKeys(p.analysisKeys);
      const s = useVisualizer.getState();
      // Options the user already changed before the saved ones arrived win.
      if (s.exportPrefs === DEFAULT_EXPORT) s.setExportPrefs(p.export);
      baseline.current = useVisualizer.getState().exportPrefs;
      loaded.current = true;
    });
    return () => {
      off = true;
    };
  }, []);

  // The analysis key of each input is remembered.
  useEffect(() => {
    if (!input || !ref || ref.key === "fixture") return;
    if (keys[input] === ref.key) return;
    keysDirty.current = true;
    setKeys((p) => {
      const next = { ...p };
      delete next[input];
      next[input] = ref.key;
      return Object.fromEntries(Object.entries(next).slice(-MAX_KEYS));
    });
  }, [input, ref, keys]);

  useEffect(() => {
    const changed = keysDirty.current || (loaded.current ? exportPrefs !== baseline.current : exportPrefs !== DEFAULT_EXPORT);
    if (!changed) return;
    const t = setTimeout(() => void patchVizState({ analysisKeys: keys, export: exportPrefs }), 300);
    return () => clearTimeout(t);
  }, [keys, exportPrefs]);
}

function Loading() {
  return (
    <div className={styles.loading}>
      <Spinner size={18} label="Loading" />
    </div>
  );
}

export default function VisualizerView({ moduleId }: ToolViewProps) {
  const input = useVisualizer((s) => s.input);
  const [lastShow, setLastShow] = useState<Show | null>(null);
  const [lastLoaded, setLastLoaded] = useState(false);
  const fixtureDone = useRef(false);

  usePrefs();
  ws.useHost();
  useToolHandoff(moduleId, applyHandoff);
  useCompositionInputs(moduleId, input ? { stems: [input], "bpm-key": [input] } : {});

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

  const show = useVisualizer((s) => s.show);
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => {
      const json = JSON.stringify(show);
      if (json.length <= MAX_STATE_BYTES) SettingsService.SetModuleState(LAST_SHOW_KEY, json).catch(() => undefined);
    }, 600);
    return () => clearTimeout(t);
  }, [show]);

  // ---- dev: the synthetic analysis ----
  useEffect(() => {
    if (fixtureDone.current || !lastLoaded) return;
    if (new URLSearchParams(window.location.search).get("vizfixture") !== "1") return;
    fixtureDone.current = true;
    const a = buildFixture();
    const s = useVisualizer.getState();
    s.setInput(FIXTURE_INPUT, false);
    s.setAnalysis(fixtureRef(a.durationMs), a);
  }, [lastLoaded]);

  return (
    <ClickInHost className={styles.root}>
      {!input ? (
        <div className={styles.empty}>
          <EmptySource />
        </div>
      ) : lastLoaded ? (
        <Suspense fallback={<Loading />}>
          <VisualizerWorkspace lastShow={lastShow} />
        </Suspense>
      ) : (
        <Loading />
      )}
    </ClickInHost>
  );
}
