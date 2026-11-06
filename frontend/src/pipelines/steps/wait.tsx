import type { PipelineWaitStep } from "@/lib/api";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";

// Wait step ("pipelines.wait", Phase 18). Wave 0 stub; WP-U2 builds the editor.

export const DEFAULT_WAIT_STEP: PipelineWaitStep = { mode: "for", minutes: 25, at: "17:00", note: "" };

export function parseWaitStep(json: string): PipelineWaitStep {
  return { ...DEFAULT_WAIT_STEP, ...(parseObject(json) as Partial<PipelineWaitStep>) };
}

function WaitEditor(_props: StepEditorProps<PipelineWaitStep>) {
  return <p>Wait options are coming.</p>;
}

export const waitSteps: ReadonlyArray<StepUI<never>> = [
  { type: "pipelines.wait", parse: parseWaitStep, Editor: WaitEditor } as unknown as StepUI<never>,
];

registerSteps(waitSteps);
