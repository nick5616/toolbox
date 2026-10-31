import type { ComponentType } from "react";
import type { StepCheck, StepVar } from "@/lib/api";

// Step editors (SPEC.md §11.4). FROZEN (Wave 0): the interfaces and functions
// below. Group files (media, compound, docs, builtin) call registerSteps.

export interface StepEditorProps<T> {
  value: T;
  onChange: (next: T) => void;
  /** Describe's answer for this step (problems, info, available vars); undefined until the first check. */
  check: StepCheck | undefined;
  /** Variables this step may use: check?.vars, else the built-ins. */
  vars: StepVar[];
}

export interface StepUI<T = unknown> {
  /** StepType.ID. */
  type: string;
  /** Parses OptionsJSON, sanitising over the defaults. Never throws. */
  parse: (optionsJson: string) => T;
  Editor: ComponentType<StepEditorProps<T>>;
}

const registry = new Map<string, StepUI>();

/** Registers step editors (each group file calls this once at import). */
export function registerSteps(list: ReadonlyArray<StepUI<never>>): void {
  for (const ui of list) registry.set(ui.type, ui as unknown as StepUI);
}

/** The editor of a step type, if any. */
export function stepUI(type: string): StepUI | undefined {
  return registry.get(type);
}

/** Every registered type (tests). */
export function registeredStepTypes(): string[] {
  return [...registry.keys()];
}

/** JSON.parse that returns {} for anything that isn't a JSON object. */
export function parseObject(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
