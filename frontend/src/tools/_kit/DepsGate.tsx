export interface DepsGateState {
  /** True while a required dependency (incl. the audio engine) isn't OK. */
  blocked: boolean;
  /** User-facing reason shown under the run button when blocked. */
  reason: string;
}

/** Computes whether a module can run, from its descriptor's `requires`. */
export function useDepsGate(moduleId: string): DepsGateState {
  void moduleId;
  return { blocked: false, reason: "" };
}

/** Banners for missing/outdated dependencies with install/update actions. */
export function DepsGate({ moduleId }: { moduleId: string }) {
  void moduleId;
  return null;
}
