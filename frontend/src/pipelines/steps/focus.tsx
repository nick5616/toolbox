import type { FocusStepOptions } from "@/lib/api";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";

// Focus step (Phase 18). Wave 0 stub; WP-U2 builds the editor (SPEC.md §5.3).

export const DEFAULT_FOCUS_STEP: FocusStepOptions = {
  action: "start",
  profileId: "",
  mode: "for",
  minutes: 50,
  at: "17:00",
  strength: "firm" as FocusStepOptions["strength"],
  extra: [],
  onStart: "close",
  ifActive: "extend",
};

export function parseFocusStep(json: string): FocusStepOptions {
  return { ...DEFAULT_FOCUS_STEP, ...(parseObject(json) as Partial<FocusStepOptions>) };
}

function FocusEditor(_props: StepEditorProps<FocusStepOptions>) {
  return <p>Focus step options are coming.</p>;
}

export const focusSteps: ReadonlyArray<StepUI<never>> = [
  { type: "focus", parse: parseFocusStep, Editor: FocusEditor } as unknown as StepUI<never>,
];

registerSteps(focusSteps);
