import { useState } from "react";
import { AppIcon, AppPicker } from "@/blocks/app-picker";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { Select } from "@/components/Select";
import { TemplateField } from "@/components/TemplateField";
import type { FocusApp, PipelineOpenStep } from "@/lib/api";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import styles from "./timing.module.css";

// Open in app ("pipelines.open", Phase 18, SPEC §4.2, §5.3): launch a program, with or without the files.

export const MAX_OPEN_ARGS = 20;

type Files = "none" | "each" | "all";
type Win = "normal" | "minimized";
type CloseWhen = "never" | "focusEnds" | "runEnds";

export const DEFAULT_OPEN_STEP: PipelineOpenStep = { app: "", label: "", args: [], files: "none", window: "normal", closeWhen: "never" };

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d);

export function parseOpenStep(json: string): PipelineOpenStep {
  const o = parseObject(json);
  return {
    app: typeof o.app === "string" ? o.app : "",
    label: typeof o.label === "string" ? o.label : "",
    args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string").slice(0, MAX_OPEN_ARGS) : [],
    files: oneOf<Files>(o.files, ["none", "each", "all"], "none"),
    window: oneOf<Win>(o.window, ["normal", "minimized"], "normal"),
    closeWhen: oneOf<CloseWhen>(o.closeWhen, ["never", "focusEnds", "runEnds"], "never"),
  };
}

/** "Open Ableton Live 12", or what's missing. */
export function openSummary(v: PipelineOpenStep): string {
  return v.app ? `Open ${v.label || v.app.split(/[\\/]/).filter(Boolean).pop() || v.app}` : "Choose an app";
}

/** The app of a pick, as step options. */
export function withApp(v: PipelineOpenStep, app: Pick<FocusApp, "label" | "path">): PipelineOpenStep {
  return { ...v, app: app.path, label: app.label };
}

const FILES_OPTIONS = [
  { value: "none", label: "Just open it" },
  { value: "each", label: "One launch per file" },
  { value: "all", label: "One launch with every file" },
] as const;

const CLOSE_OPTIONS = [
  { value: "never", label: "Leave it open" },
  { value: "focusEnds", label: "Ask it to close when focus ends" },
  { value: "runEnds", label: "Ask it to close when the run ends" },
] as const;

function OpenEditor({ value, onChange, vars }: StepEditorProps<PipelineOpenStep>) {
  const [picking, setPicking] = useState(false);
  const args = value.args ?? [];
  const set = (patch: Partial<PipelineOpenStep>) => onChange({ ...value, ...patch });
  const setArg = (i: number, v: string) => set({ args: args.map((a, j) => (j === i ? v : a)) });
  return (
    <div className={styles.root}>
      <Field label="App" error={value.app === "" ? "Choose the program to open" : undefined}>
        {() => (
          <div className={styles.app}>
            {value.app && <AppIcon path={value.app} label={value.label || value.app} size={20} />}
            {value.app && (
              <span className={styles.appName} data-tip={value.app}>
                {value.label || value.app}
              </span>
            )}
            <Button size="sm" variant="secondary" icon="app-window" data-tip="Pick from installed or running apps, or browse" onClick={() => setPicking(true)}>
              {value.app ? "Change…" : "Choose app…"}
            </Button>
          </div>
        )}
      </Field>
      <AppPicker open={picking} onClose={() => setPicking(false)} mode="app" title="Choose an app" onPickApp={(app) => onChange(withApp(value, app))} />
      <Field label="Files">
        {(c) => <Select id={c.id} value={value.files as Files} options={FILES_OPTIONS} onChange={(files) => set({ files })} />}
      </Field>
      <Field label={`Arguments (${args.length})`} hint={'Each takes {variables} and {file}. An argument of exactly "{files}" becomes every file.'}>
        {() => (
          <div className={styles.list}>
            {args.map((a, i) => (
              <div key={i} className={styles.argRow}>
                <TemplateField label={`Argument ${i + 1}`} value={a} vars={vars} placeholder="{file}" onChange={(v) => setArg(i, v)} />
                <IconButton size="sm" icon="x" label={`Remove argument ${i + 1}`} onClick={() => set({ args: args.filter((_, j) => j !== i) })} />
              </div>
            ))}
            <div>
              <Button
                size="sm"
                variant="secondary"
                icon="plus"
                aria-disabled={args.length >= MAX_OPEN_ARGS}
                data-tip={args.length >= MAX_OPEN_ARGS ? `At most ${MAX_OPEN_ARGS} arguments` : "Add a command-line argument"}
                onClick={() => args.length < MAX_OPEN_ARGS && set({ args: [...args, ""] })}
              >
                Add argument
              </Button>
            </div>
          </div>
        )}
      </Field>
      <Field label="Window">
        {(c) => (
          <Select
            id={c.id}
            value={value.window as Win}
            options={[
              { value: "normal", label: "Normal" },
              { value: "minimized", label: "Minimized" },
            ]}
            onChange={(window) => set({ window })}
          />
        )}
      </Field>
      <Field label="Close when" hint="Closing is always polite: the app is asked to close and can ask about saving.">
        {(c) => <Select id={c.id} value={value.closeWhen as CloseWhen} options={CLOSE_OPTIONS} onChange={(closeWhen) => set({ closeWhen })} />}
      </Field>
    </div>
  );
}

export const openSteps: ReadonlyArray<StepUI<never>> = [
  {
    type: "pipelines.open",
    parse: parseOpenStep,
    Editor: OpenEditor,
    params: {
      // The program is chosen in the editor; never from a variable or a file.
      "/app": { hidden: true },
      "/label": { hidden: true },
      "/files": {
        label: "Files",
        type: "choice",
        choices: FILES_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        primary: true,
      },
      "/window": {
        label: "Window",
        type: "choice",
        choices: [
          { value: "normal", label: "Normal" },
          { value: "minimized", label: "Minimized" },
        ],
      },
      "/closeWhen": { label: "Close when", type: "choice", choices: CLOSE_OPTIONS.map((o) => ({ value: o.value, label: o.label })), primary: true },
    },
  } as unknown as StepUI<never>,
];

registerSteps(openSteps);
