import { Field } from "@/components/Field";
import { Stepper } from "@/components/Stepper";
import { TextField } from "@/components/TextField";
import type { GradeStepOptions } from "@/lib/api";
import { num, oneOf, str, ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// Color Grader's step "Grade with a look" ("grade"), Phase 21 SPEC §E1.
// Wave 0: the options and a plain editor; G3 adds the look picker.

/** Mirrors modules/grade DefaultStepOptions(). */
export const DEFAULT_GRADE_STEP: GradeStepOptions = { look: "teal-orange", wild: 0.5, seed: 0, vibe: "", format: "same" };

const FORMATS = ["same", "jpg", "png", "webp"] as const;

export function parseGradeStep(json: string): GradeStepOptions {
  const r = parseObject(json);
  const d = DEFAULT_GRADE_STEP;
  const wild = num(r.wild, d.wild);
  const seed = Math.round(num(r.seed, d.seed));
  return {
    ...r,
    look: str(r.look, d.look),
    wild: wild >= 0 && wild <= 1 ? wild : d.wild,
    seed: seed >= 0 && seed <= 0xffffffff ? seed : d.seed,
    vibe: str(r.vibe, d.vibe),
    format: oneOf(r.format, FORMATS, d.format as (typeof FORMATS)[number]),
  };
}

function GradeEditor({ value, onChange }: StepEditorProps<GradeStepOptions>) {
  const set = (patch: Partial<GradeStepOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Field label="Look">
        <TextField value={value.look} onChange={(e) => set({ look: e.target.value })} aria-label="Look" />
      </Field>
      <Field label="Wildness">
        <Stepper value={Math.round(value.wild * 100)} min={0} max={100} step={5} onChange={(v) => set({ wild: v / 100 })} aria-label="Wildness" />
      </Field>
      <Field label="Vibe (the chat model writes the look)">
        <TextField value={value.vibe} onChange={(e) => set({ vibe: e.target.value })} aria-label="Vibe" />
      </Field>
    </div>
  );
}

registerSteps([ui<GradeStepOptions>("grade", parseGradeStep, GradeEditor)]);
