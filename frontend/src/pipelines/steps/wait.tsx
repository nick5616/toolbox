import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Stepper } from "@/components/Stepper";
import { TextField } from "@/components/TextField";
import type { PipelineWaitStep } from "@/lib/api";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import { clampInt, isHHMM, minutesText } from "./timeUtil";
import styles from "./timing.module.css";

// Wait step ("pipelines.wait", Phase 18, SPEC §3.2): pause the run for a while or until a time of day.

export const MAX_WAIT_MINUTES = 1440;
export const MAX_WAIT_NOTE = 200;

export const DEFAULT_WAIT_STEP: PipelineWaitStep = { mode: "for", minutes: 25, at: "17:00", note: "" };

export function parseWaitStep(json: string): PipelineWaitStep {
  const o = parseObject(json);
  return {
    mode: o.mode === "until" ? "until" : "for",
    minutes: clampInt(o.minutes, 1, MAX_WAIT_MINUTES, DEFAULT_WAIT_STEP.minutes),
    at: typeof o.at === "string" && isHHMM(o.at) ? o.at : DEFAULT_WAIT_STEP.at,
    note: typeof o.note === "string" ? o.note.slice(0, MAX_WAIT_NOTE) : "",
  };
}

/** The step's one-line summary: "25 min" or "until 17:00". */
export function waitSummary(v: PipelineWaitStep): string {
  return v.mode === "until" ? `until ${v.at}` : minutesText(v.minutes);
}

function WaitEditor({ value, onChange }: StepEditorProps<PipelineWaitStep>) {
  const set = (patch: Partial<PipelineWaitStep>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <SegmentedControl
          size="sm"
          aria-label="Wait mode"
          value={value.mode === "until" ? "until" : "for"}
          onChange={(mode) => set({ mode })}
          options={[
            { value: "for", label: "For", tip: "Wait a number of minutes" },
            { value: "until", label: "Until", tip: "Wait until a time of day" },
          ]}
        />
        {value.mode === "until" ? (
          <Field label="Time" error={isHHMM(value.at) ? undefined : "Use HH:MM, 24 hour"}>
            {(c) => <TextField {...c} type="time" size="sm" value={value.at} onChange={(e) => set({ at: e.target.value })} />}
          </Field>
        ) : (
          <Field label="Minutes">
            {(c) => <Stepper id={c.id} value={value.minutes} min={1} max={MAX_WAIT_MINUTES} step={5} unit="min" onChange={(minutes) => set({ minutes })} />}
          </Field>
        )}
      </div>
      <Field label="Note (optional)" hint="Shown on the waiting card in the run">
        {(c) => <TextField {...c} size="sm" maxLength={MAX_WAIT_NOTE} value={value.note} placeholder="Break" onChange={(e) => set({ note: e.target.value })} />}
      </Field>
      <p className={styles.hint}>With several files each one waits on its own clock. Press Continue now on the run to skip the wait.</p>
    </div>
  );
}

export const waitSteps: ReadonlyArray<StepUI<never>> = [
  {
    type: "pipelines.wait",
    parse: parseWaitStep,
    Editor: WaitEditor,
    params: {
      "/mode": {
        label: "Wait",
        type: "choice",
        choices: [
          { value: "for", label: "For a while" },
          { value: "until", label: "Until a time" },
        ],
        primary: true,
      },
      "/minutes": { label: "Minutes", min: 1, max: MAX_WAIT_MINUTES, primary: true },
      "/at": { label: "Time (HH:MM)", tip: "24 hour, local time", primary: true },
      "/note": { label: "Note" },
    },
    relevant: (o: Record<string, unknown>, pointer: string) => (pointer === "/minutes" ? o.mode !== "until" : pointer === "/at" ? o.mode === "until" : true),
  } as unknown as StepUI<never>,
];

registerSteps(waitSteps);
