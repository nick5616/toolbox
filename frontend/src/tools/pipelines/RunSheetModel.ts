import type { Accepts } from "@/lib/api";
import { acceptsPath } from "@/tools/_kit/accepts";

// Which inputs a pipeline run takes (shared by the Run sheet and the shell's drop routing).

export function isLink(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/** True when a run of a pipeline taking `accepts` can use this path or link. */
export function inputAccepted(accepts: Accepts, input: string): boolean {
  if (isLink(input)) return accepts.urls;
  if (accepts.any) return true;
  const exts = accepts.extensions ?? [];
  return exts.length > 0 && acceptsPath(exts, input);
}

/** True when the pipeline takes at least one file path. */
export function takesPaths(accepts: Accepts): boolean {
  return accepts.any || (accepts.extensions ?? []).length > 0;
}

export function mergeInputs(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set(a);
  const out = [...a];
  for (const x of b) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
