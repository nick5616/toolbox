/** The driver picker for Edit Studio reactions: the visualizer's signal groups plus a Markers group (§14.8). */
import { useMemo } from "react";
import { isMarkerSignal } from "@/viz/edit/schema";
import { MARKER_LANES, type EditSignalId, type MarkerLane } from "@/viz/edit/types";
import { SIGNALS, type SignalMeta } from "@/viz/signals";
import styles from "./inspector.module.css";

const GROUP_ORDER: Array<SignalMeta["group"]> = ["Instruments", "Rhythm", "Song", "Voice", "Words & mood", "Drift", "Whole song"];

export const LANE_LABELS: Record<MarkerLane, string> = {
  beat: "Beats",
  downbeat: "Downbeats",
  kick: "Kicks",
  snare: "Snares",
  hats: "Hi-hats",
  bass: "Bass hits",
  vocals: "Vocal hits",
  other: "Other hits",
  section: "Section starts",
  drop: "Drops",
  lift: "Build-ups",
  break: "Breaks",
  stop: "Stops",
  phrase: "Phrases",
  word: "Words",
  custom: "Custom markers",
  accent: "Accents (stand-out hits)",
};

export function signalLabel(id: EditSignalId): string {
  if (isMarkerSignal(id)) return LANE_LABELS[id.slice("marker.".length) as MarkerLane] ?? id;
  return SIGNALS.find((s) => s.id === id)?.label ?? id;
}

export interface EditSignalSelectProps {
  value: EditSignalId;
  onChange(v: EditSignalId): void;
  label: string;
}

export function EditSignalSelect({ value, onChange, label }: EditSignalSelectProps) {
  const groups = useMemo(() => GROUP_ORDER.map((g) => ({ group: g, items: SIGNALS.filter((s) => s.group === g && s.id !== "time") })).filter((g) => g.items.length > 0), []);
  const lane = isMarkerSignal(value) ? (value.slice("marker.".length) as MarkerLane) : null;
  return (
    <span className={styles.signalSelect}>
      {lane && <span className={styles.swatch} data-testid="lane-swatch" style={{ background: `var(--lane-${lane})` }} />}
      <select className={styles.nativeSelect} data-tip="What drives this: a marker lane (beats, kicks…) or a signal from the song" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as EditSignalId)}>
        <optgroup label="Markers">
          {MARKER_LANES.map((l) => (
            <option key={l} value={`marker.${l}`}>
              {LANE_LABELS[l]}
            </option>
          ))}
        </optgroup>
        {groups.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </span>
  );
}
