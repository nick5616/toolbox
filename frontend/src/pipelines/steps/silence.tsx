import { Field } from "@/components/Field";
import { Stepper } from "@/components/Stepper";
import { Switch } from "@/components/Switch";
import type { SilenceStepOptions } from "@/lib/api";
import { DEFAULT_SILENCE_OPTIONS, SILENCE_LIMITS, sanitizeSilenceOptions } from "@/tools/silence/options";
import { ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// Step editor of the Silence Cutter ("silence"), Phase 15. parse() keeps
// unknown fields and clamps every number to what Go accepts.

/** Mirrors modules/silence DefaultStepOptions(). */
export const DEFAULT_SILENCE_STEP: SilenceStepOptions = { ...DEFAULT_SILENCE_OPTIONS };

export function parseSilenceStep(json: string): SilenceStepOptions {
  const r = parseObject(json);
  return { ...r, ...sanitizeSilenceOptions(r, DEFAULT_SILENCE_STEP) };
}

function SilenceEditor({ value, onChange }: StepEditorProps<SilenceStepOptions>) {
  const set = (patch: Partial<SilenceStepOptions>) => onChange({ ...value, ...patch });
  const L = SILENCE_LIMITS;
  return (
    <div className={styles.stack}>
      <div className={styles.pair}>
        <Field label="Silence below">
          {(c) => <Stepper id={c.id} aria-label="Silence below" value={value.thresholdDb} min={L.thresholdDb.min} max={L.thresholdDb.max} unit="dB" onChange={(thresholdDb) => set({ thresholdDb })} />}
        </Field>
        <Field label="Shortest silence">
          {(c) => (
            <Stepper
              id={c.id}
              aria-label="Shortest silence"
              value={value.minSilenceMs / 1000}
              min={L.minSilenceMs.min / 1000}
              max={L.minSilenceMs.max / 1000}
              step={0.1}
              unit="s"
              onChange={(s) => set({ minSilenceMs: Math.round(s * 1000) })}
            />
          )}
        </Field>
      </div>
      <div className={styles.pair}>
        <Field label="Padding">
          {(c) => <Stepper id={c.id} aria-label="Padding" value={value.paddingMs} min={L.paddingMs.min} max={L.paddingMs.max} step={50} unit="ms" onChange={(paddingMs) => set({ paddingMs })} />}
        </Field>
        <Field label="Smooth joins">
          {(c) => <Stepper id={c.id} aria-label="Smooth joins" value={value.crossfadeMs} min={L.crossfadeMs.min} max={L.crossfadeMs.max} step={5} unit="ms" onChange={(crossfadeMs) => set({ crossfadeMs })} />}
        </Field>
      </div>
      <Switch checked={value.cutList} onChange={(cutList) => set({ cutList })} label="Also save a cut list (.csv)" />
      <p className={styles.hint}>Later steps can use the cut file, the cut list, and the variables {"{removed_s}"} and {"{kept_s}"}.</p>
    </div>
  );
}

export const silenceSteps = [ui("silence", parseSilenceStep, SilenceEditor)];

registerSteps(silenceSteps);
