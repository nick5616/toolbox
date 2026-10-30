/**
 * Visualizer step 3 (SPEC.md §8.3): hosts the VisualDesigner with the engine's
 * own text, owns the undo history and keeps the design in the store.
 *
 * Props: `lastShow` (the persisted design to start from), `onExport` (the next step).
 */
import { useEffect, useMemo, useRef } from "react";
import { Banner, Button, IconButton, Spinner, toast } from "@/components";
import { useMediaSource } from "@/components/media";
import { useVisualsAnalysis } from "@/components/viz";
import { PRESETS, presetById, showFromPreset } from "@/viz/presets";
import type { Show } from "@/viz/types";
import { useMyPresets } from "./designer/myPresets";
import { applyTemplate } from "./designer/model";
import { useShowHistory, useUndoKeys } from "./designer/useShowHistory";
import { VisualDesigner } from "./designer/VisualDesigner";
import { aspectValue, type Aspect } from "./exportPrefs";
import { useVisualizer } from "./store";
import { seededShow } from "./useSeed";
import styles from "./DesignStep.module.css";

export interface DesignStepProps {
  lastShow?: Show | null;
  aspect: Aspect;
  onExport?: () => void;
  onBack?: () => void;
}

/** The design a new session starts from: the kept one, the seed's, or the house preset. */
export function initialShow(opts: { current: Show | null; last: Show | null | undefined; mode: "full" | "overlay" }): Show {
  if (opts.current) return opts.current;
  if (opts.last) return opts.last;
  const preset = presetById("golden-hour") ?? PRESETS[0];
  if (!preset) throw new Error("No presets are registered");
  return applyTemplate(showFromPreset(preset), { mode: opts.mode, engineText: true });
}

export default function DesignStep({ lastShow, aspect, onExport, onBack }: DesignStepProps) {
  const input = useVisualizer((s) => s.input);
  const isVideo = useVisualizer((s) => s.isVideo);
  const mode = useVisualizer((s) => s.mode);
  const stored = useVisualizer((s) => s.analysis);
  const analyze = useVisualizer((s) => s.analyze);
  const seedLook = useVisualizer((s) => s.seedLook);
  const setStore = useVisualizer((s) => s.setShow);
  const setSeedLook = useVisualizer((s) => s.setSeedLook);

  // The analysis normally comes from the Analyze step; coming back to a file loads it from the cache.
  const loaded = useVisualsAnalysis(stored ? null : input, { analyze, auto: false });
  const analysis = stored ?? loaded.analysis;

  const history = useShowHistory(
    useMemo(() => {
      const s = useVisualizer.getState();
      const seeded = s.seedLook ? seededShow(s.seedLook, s.mode) : null;
      return seeded ?? initialShow({ current: s.show, last: lastShow, mode: s.mode });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  useUndoKeys(history);

  // A seed that arrived with this step already mounted restarts the design.
  const resetRef = useRef(history.reset);
  resetRef.current = history.reset;
  useEffect(() => {
    if (!seedLook) return;
    const seeded = seededShow(seedLook, mode);
    if (seeded) resetRef.current(seeded);
    setSeedLook(null);
  }, [seedLook, mode, setSeedLook]);

  useEffect(() => {
    setStore(history.show);
  }, [history.show, setStore]);

  const info = useMediaSource(isVideo && mode === "overlay" ? input : null).source?.info;
  const vw = info?.video?.width ?? 0;
  const vh = info?.video?.height ?? 0;
  const designAspect = mode === "overlay" && vw > 0 && vh > 0 ? vw / vh : aspectValue(aspect);

  const savePreset = async (show: Show) => {
    const err = await useMyPresets.getState().add(show);
    toast(err ? { title: err, tone: "danger" } : { title: `Saved "${show.name}" to My presets`, tone: "success" });
  };

  if (!input) return <Banner tone="info" title="Choose a song first." />;
  if (!analysis) {
    return loaded.status === "error" ? (
      <Banner tone="danger" title={loaded.error?.message ?? "Couldn't load the analysis"} action={onBack && <Button size="sm" onClick={onBack}>Back</Button>}>
        {loaded.error?.hint}
      </Banner>
    ) : (
      <div className={styles.loading}>
        <Spinner size={18} label="Loading" /> Loading the analysis…
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <IconButton icon="undo-2" label="Undo" kbd="Mod+Z" disabled={!history.canUndo} onClick={history.undo} />
        <IconButton icon="redo-2" label="Redo" kbd="Mod+Shift+Z" disabled={!history.canRedo} onClick={history.redo} />
        <span className={styles.name}>{history.show.name}</span>
        <span className={styles.spacer} />
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <Button variant="primary" icon="film" onClick={onExport}>
          Export
        </Button>
      </div>
      <VisualDesigner
        inputPath={input}
        analysis={analysis}
        show={history.show}
        onChange={history.set}
        aspect={designAspect}
        mode={mode}
        player={null}
        text="engine"
        onSavePreset={(s) => void savePreset(s)}
      />
    </div>
  );
}
