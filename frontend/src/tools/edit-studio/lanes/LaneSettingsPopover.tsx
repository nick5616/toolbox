/** A lane's settings (§14.4): threshold with a live count, every N, first of bar, nudge, reset; the downbeat lane also sets the bar start. */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button, SegmentedControl, Slider, Stepper, Switch } from "@/components";
import { laneSettings } from "@/viz/edit/defaults";
import type { MarkerLane } from "@/viz/edit/types";
import { useEditStudio, useProject } from "@/editor/store";
import { LANE_LABELS, resetLaneOverrides, resetLaneSettings, withLane } from "./laneLogic";
import styles from "./Lanes.module.css";

export interface LaneSettingsPopoverProps {
  lane: MarkerLane;
  /** Markers the lane shows now (live count). */
  count: number;
  /** The ⋯ button's rectangle. */
  anchor: DOMRect;
  /** The analysis has stems (the drum lanes get finer picking below 0.1). */
  stems: boolean;
  onClose: () => void;
}

const BEATS = [
  { value: "0", label: "1", tip: "Bars start on beat 1 (as detected)" },
  { value: "1", label: "2", tip: "Bars start on beat 2 (shifts every bar by one beat)" },
  { value: "2", label: "3", tip: "Bars start on beat 3 (shifts every bar by two beats)" },
  { value: "3", label: "4", tip: "Bars start on beat 4 (shifts every bar by three beats)" },
] as const;

export function LaneSettingsPopover({ lane, count, anchor, stems, onClose }: LaneSettingsPopoverProps) {
  const project = useProject();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-pop-anchor]")) return;
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!project) return null;
  const s = laneSettings(project.markers, lane);
  const change = (patch: Partial<typeof s>, key: string) => {
    const p = useEditStudio.getState().history?.present;
    if (p) useEditStudio.getState().edit(withLane(p, lane, patch), `lane:${lane}:${key}`);
  };
  const reset = (fn: typeof resetLaneOverrides) => {
    const p = useEditStudio.getState().history?.present;
    if (p) useEditStudio.getState().edit(fn(p, lane));
  };
  const left = Math.max(8, Math.min(window.innerWidth - 268, anchor.left));
  const top = Math.min(window.innerHeight - 340, anchor.bottom + 4);
  const finer = stems && (lane === "kick" || lane === "snare" || lane === "hats") && s.minStrength < 0.1;
  const customLane = lane === "custom";

  return createPortal(
    <div ref={ref} className={styles.popover} style={{ left, top: Math.max(8, top) }} role="dialog" aria-label={`${LANE_LABELS[lane]} settings`}>
      <div className={styles.popTitle}>
        <span>{LANE_LABELS[lane]}</span>
        <span className={styles.count} data-tip="How many markers this lane has with the current settings">{count} markers</span>
      </div>
      {lane === "downbeat" && (
        <div className={styles.popRow}>
          <span className={styles.popLabel} data-tip="Which detected beat counts as the first of each bar">Bar starts on beat</span>
          <SegmentedControl
            aria-label="Bar starts on beat"
            size="sm"
            value={String(project.markers.barOffset) as (typeof BEATS)[number]["value"]}
            options={BEATS}
            onChange={(v) => {
              const p = useEditStudio.getState().history?.present;
              if (p) useEditStudio.getState().edit({ ...p, markers: { ...p.markers, barOffset: Number(v) } });
            }}
          />
        </div>
      )}
      {!customLane && (
        <>
          <div className={styles.popRow}>
            <span className={styles.popLabel}>
              <span data-tip="Hide markers weaker than this; raise it to keep only the strongest hits">Strength threshold</span>
            </span>
            <Slider aria-label="Strength threshold" min={0} max={1} step={0.01} value={s.minStrength} format={(v) => v.toFixed(2)} onChange={(v) => change({ minStrength: v }, "min")} />
            {finer && <span className={styles.popHint}>Picking every hit from the drum track.</span>}
          </div>
          <div className={styles.popRow}>
            <span className={styles.popLabel} data-tip="Keep every 1st, 2nd, 3rd… marker and drop the ones between">Keep every</span>
            <Stepper aria-label="Keep every Nth marker" min={1} max={16} step={1} value={s.every} onChange={(v) => change({ every: Math.round(v) }, "every")} unit="th" />
          </div>
          <Switch label="Only the first in each bar" tip="Keep only the first marker of every bar, e.g. just the downbeat kick" checked={s.firstOfBar} onChange={(v) => change({ firstOfBar: v }, "first")} />
          <div className={styles.popRow}>
            <span className={styles.popLabel} data-tip="Shift every marker in this lane earlier (negative) or later (positive), in milliseconds">Nudge</span>
            <Slider aria-label="Nudge" min={-200} max={200} step={5} value={s.nudgeMs} format={(v) => `${v} ms`} onChange={(v) => change({ nudgeMs: v }, "nudge")} />
          </div>
        </>
      )}
      <div className={styles.popActions}>
        <Button size="sm" variant="secondary" onClick={() => reset(resetLaneOverrides)} data-tip="Bring back deleted markers and undo moves in this lane">
          Reset lane
        </Button>
        {!customLane && (
          <Button size="sm" variant="ghost" data-tip="Put threshold, every-Nth, first-of-bar and nudge back to their defaults" onClick={() => reset(resetLaneSettings)}>
            Defaults
          </Button>
        )}
      </div>
    </div>,
    document.body,
  );
}
