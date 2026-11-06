import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Slider } from "@/components/Slider";
import { Stepper } from "@/components/Stepper";
import { SceneKeep, SceneOutput, type ScenesStepOptions } from "@/lib/api";
import { num, oneOf, ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import styles from "./phase14.module.css";

// Step editor of the Scene Splitter ("scenes"), Phase 15. parse() keeps unknown
// fields and fills anything missing or out of range with the default.

/** Mirrors modules/scenes DefaultStepOptions(): stills of every scene. */
export const DEFAULT_SCENES_STEP: ScenesStepOptions = {
  threshold: 0.3,
  minSceneSecs: 1,
  output: SceneOutput.OutputStills,
  keep: SceneKeep.KeepAll,
  keepN: 10,
};

const OUTPUTS = [SceneOutput.OutputStills, SceneOutput.OutputClips, SceneOutput.OutputBoth] as const;
const KEEPS = [SceneKeep.KeepAll, SceneKeep.KeepLongest, SceneKeep.KeepActive] as const;

const inRange = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = num(v, d);
  return n >= lo && n <= hi ? n : d;
};

export function parseScenesStep(json: string): ScenesStepOptions {
  const r = parseObject(json);
  const d = DEFAULT_SCENES_STEP;
  return {
    ...r,
    threshold: inRange(r.threshold, 0.05, 0.9, d.threshold),
    minSceneSecs: inRange(r.minSceneSecs, 0.2, 60, d.minSceneSecs),
    output: oneOf(r.output, OUTPUTS, d.output),
    keep: oneOf(r.keep, KEEPS, d.keep),
    keepN: Math.round(inRange(r.keepN, 1, 200, d.keepN)),
  };
}

function ScenesEditor({ value, onChange }: StepEditorProps<ScenesStepOptions>) {
  const set = (patch: Partial<ScenesStepOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Field label="Save">
        <SegmentedControl<SceneOutput>
          aria-label="Save"
          value={value.output}
          options={[
            { value: SceneOutput.OutputStills, label: "Stills", tip: "One picture per scene, from its middle" },
            { value: SceneOutput.OutputClips, label: "Clips", tip: "Each scene as its own video" },
            { value: SceneOutput.OutputBoth, label: "Both" },
          ]}
          onChange={(output) => set({ output })}
        />
      </Field>
      <Field label="Keep">
        {(c) => (
          <Select<SceneKeep>
            {...c}
            value={value.keep}
            options={[
              { value: SceneKeep.KeepAll, label: "All scenes" },
              { value: SceneKeep.KeepLongest, label: "The longest" },
              { value: SceneKeep.KeepActive, label: "The most active" },
            ]}
            onChange={(keep) => set({ keep })}
          />
        )}
      </Field>
      {value.keep !== SceneKeep.KeepAll && (
        <Field label="How many">
          {(c) => <Stepper id={c.id} aria-label="How many" value={value.keepN} min={1} max={200} step={1} onChange={(keepN) => set({ keepN })} />}
        </Field>
      )}
      <Field label="Sensitivity">
        {(c) => <Slider id={c.id} aria-label="Sensitivity" min={0.05} max={0.9} step={0.05} value={value.threshold} format={(v) => v.toFixed(2)} onChange={(threshold) => set({ threshold })} />}
      </Field>
      <Field label="Shortest scene">
        {(c) => <Stepper id={c.id} aria-label="Shortest scene" value={value.minSceneSecs} min={0.2} max={60} step={0.5} unit="s" onChange={(minSceneSecs) => set({ minSceneSecs })} />}
      </Field>
      <p className={styles.hint}>Finds where the picture changes. Later steps get the scenes as separate files; {"{scene}"} is how many were kept.</p>
    </div>
  );
}

export const scenesSteps: ReadonlyArray<StepUI<never>> = [ui<ScenesStepOptions>("scenes", parseScenesStep, ScenesEditor)];

registerSteps(scenesSteps);
