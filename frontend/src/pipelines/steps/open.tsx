import type { PipelineOpenStep } from "@/lib/api";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";

// Open in app ("pipelines.open", Phase 18). Wave 0 stub; WP-U2 builds the editor.

export const DEFAULT_OPEN_STEP: PipelineOpenStep = { app: "", label: "", args: [], files: "none", window: "normal", closeWhen: "never" };

export function parseOpenStep(json: string): PipelineOpenStep {
  return { ...DEFAULT_OPEN_STEP, ...(parseObject(json) as Partial<PipelineOpenStep>) };
}

function OpenEditor(_props: StepEditorProps<PipelineOpenStep>) {
  return <p>Open in app options are coming.</p>;
}

export const openSteps: ReadonlyArray<StepUI<never>> = [
  { type: "pipelines.open", parse: parseOpenStep, Editor: OpenEditor } as unknown as StepUI<never>,
];

registerSteps(openSteps);
