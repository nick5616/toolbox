/** Reactions of one EditParam (the designer's ModsEditor pattern, plus marker signals, `every` and section chips). */
import { IconButton, Select, Slider, Stepper } from "@/components";
import { isMarkerSignal, MAX_MODS } from "@/viz/edit/schema";
import type { EditMod, EditSignalId } from "@/viz/edit/types";
import { DEFAULT_ATTACK_MS, DEFAULT_RELEASE_MS } from "@/viz/signals";
import { SECTION_LABELS, type ModShape, type SectionLabel } from "@/viz/types";
import { EditSignalSelect, signalLabel } from "./EditSignalSelect";
import { modLevel, useEditSignals, useLivePlayheadMs } from "./useEditSignals";
import styles from "./inspector.module.css";

export const SHAPES: Array<{ value: ModShape; label: string }> = [
  { value: "linear", label: "Linear" },
  { value: "ease", label: "Smooth" },
  { value: "exp", label: "Punchy" },
  { value: "gate", label: "On/off" },
];

export const DEFAULT_EDIT_MOD: EditMod = { signal: "marker.beat", amount: 0.5, shape: "exp", attackMs: 5, releaseMs: 160 };

/** A live meter of what drives one reaction at the playhead (0 until the analysis is loaded). */
export function ModMeter({ mod, label }: { mod: EditMod; label: string }) {
  const src = useEditSignals();
  const ms = useLivePlayheadMs();
  const v = src ? modLevel(src, mod, ms) : 0;
  return (
    <span className={styles.liveMeter} data-tip="Live level of this reaction at the playhead" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.round(v * 100) / 100}>
      <span className={styles.liveFill} style={{ width: `${Math.round(v * 100)}%` }} />
    </span>
  );
}

export interface EditModsEditorProps {
  mods: readonly EditMod[];
  onChange(mods: EditMod[]): void;
  /** Name of the parameter, for accessible labels. */
  label: string;
}

export function EditModsEditor({ mods, onChange, label }: EditModsEditorProps) {
  const patch = (i: number, p: Partial<EditMod>) => onChange(mods.map((m, k) => (k === i ? { ...m, ...p } : m)));
  const setSignal = (i: number, signal: EditSignalId) => {
    const cur = mods[i];
    if (!cur) return;
    const next: EditMod = { ...cur, signal };
    if (!isMarkerSignal(signal)) delete next.every; // "every" works only with marker signals
    onChange(mods.map((m, k) => (k === i ? next : m)));
  };
  const toggleSection = (i: number, s: SectionLabel) => {
    const cur = mods[i];
    if (!cur) return;
    const has = cur.sections?.includes(s) ?? false;
    const list = has ? (cur.sections ?? []).filter((x) => x !== s) : [...(cur.sections ?? []), s];
    const next: EditMod = { ...cur };
    if (list.length) next.sections = list;
    else delete next.sections;
    onChange(mods.map((m, k) => (k === i ? next : m)));
  };
  return (
    <div className={styles.mods} role="group" aria-label={`Reactions of ${label}`}>
      {mods.length === 0 && <p className={styles.hint}>Nothing drives this yet.</p>}
      {mods.map((m, i) => (
        <div key={i} className={styles.mod}>
          <div className={styles.modTop}>
            <EditSignalSelect label="Driver" value={m.signal} onChange={(s) => setSignal(i, s)} />
            <ModMeter mod={m} label={`${signalLabel(m.signal)} level`} />
            <IconButton size="sm" icon="x" label="Remove reaction" data-tip="Stop this signal from driving the parameter" onClick={() => onChange(mods.filter((_, k) => k !== i))} />
          </div>
          <Select size="sm" data-tip="How the signal turns into movement: smooth, punchy (sharp hit, fast fade) or on/off" aria-label="Shape" value={m.shape} onChange={(shape) => patch(i, { shape })} options={SHAPES} />
          <Slider data-tip="How far the signal pushes the value, as a share of its range; negative pushes the other way" aria-label="Amount" min={-2} max={2} step={0.05} value={m.amount} onChange={(amount) => patch(i, { amount })} format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`} />
          <div className={styles.modTimes}>
            <label className={styles.inline} data-tip="How fast the value rises when the signal hits, in milliseconds">
              <span>Attack</span>
              <Stepper aria-label="Attack" unit="ms" min={0} max={5000} step={5} value={m.attackMs ?? DEFAULT_ATTACK_MS} onChange={(attackMs) => patch(i, { attackMs })} />
            </label>
            <label className={styles.inline} data-tip="How slowly the value falls back after a hit, in milliseconds">
              <span>Release</span>
              <Stepper aria-label="Release" unit="ms" min={0} max={5000} step={10} value={m.releaseMs ?? DEFAULT_RELEASE_MS} onChange={(releaseMs) => patch(i, { releaseMs })} />
            </label>
            {isMarkerSignal(m.signal) && (
              <label className={styles.inline} data-tip="React to every Nth marker only, e.g. 4 = every fourth beat">
                <span>Every</span>
                <Stepper aria-label="Every" min={1} max={16} step={1} value={m.every ?? 1} onChange={(every) => patch(i, { every })} />
              </label>
            )}
          </div>
          <div className={styles.chips} role="group" aria-label="Only in these sections" data-tip="Limit this reaction to chosen song sections; none selected means everywhere">
            {SECTION_LABELS.map((s) => (
              <button key={s} type="button" data-tip={`React only during ${s} sections (click again to remove)`} className={styles.chip} aria-pressed={m.sections?.includes(s) ?? false} onClick={() => toggleSection(i, s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button type="button" data-tip={mods.length >= MAX_MODS ? "This parameter has the most reactions it can take" : "Add another signal that drives this parameter"} className={styles.linkBtn} disabled={mods.length >= MAX_MODS} onClick={() => onChange([...mods, { ...DEFAULT_EDIT_MOD }])}>
        + Add a reaction
      </button>
    </div>
  );
}
