import type { ReactNode } from "react";
import type { FileInputs } from "./useFileInputs";

export interface FileToolLayoutProps {
  moduleId: string;
  inputs: FileInputs;
  /** Options section (rendered between inputs and the run button). */
  options?: ReactNode;
  /** Run button label, e.g. "Split 3 tracks". */
  runLabel: string;
  onRun: () => void | Promise<void>;
  /** Extra reason to disable the run button (deps are handled by the layout). */
  runDisabledReason?: string;
  /** Running state for the button spinner. */
  running?: boolean;
  /** Per-input error messages keyed by path (shown inline in the file list). */
  inputErrors?: Record<string, string>;
  /** Results section (rendered below Active jobs). */
  results?: ReactNode;
}

/** Shared layout for file-based tools (SPEC.md §7.1). */
export function FileToolLayout({ moduleId }: FileToolLayoutProps) {
  return <section aria-label={moduleId} />;
}
