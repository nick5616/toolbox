import { toast } from "@/components";
import type { Job } from "@/lib/api";
import { toAppError } from "@/lib/errors";

/** Maps validation fields `inputs.N` onto the submitted paths. */
export function mapInputErrors(fields: Record<string, string> | undefined, paths: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fields) return out;
  for (const [key, msg] of Object.entries(fields)) {
    const m = /^inputs\.(\d+)$/.exec(key);
    if (!m) continue;
    const path = paths[Number(m[1])];
    if (path !== undefined) out[path] = msg;
  }
  return out;
}

/** "3 tracks queued" / "1 track queued". */
export function queuedMessage(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural} queued`;
}

export interface SubmitResult {
  ok: boolean;
  /** Per-path messages when the failure was input validation. */
  inputErrors: Record<string, string>;
}

/**
 * Runs an Enqueue call, toasting success or failure. Validation errors that
 * point at inputs are returned (and summarised in a toast) so the file list
 * can show them inline.
 */
export async function submitJobs(
  call: () => Promise<Job[] | null>,
  paths: readonly string[],
  noun: [singular: string, plural: string],
): Promise<SubmitResult> {
  try {
    const jobs = await call();
    toast({ title: queuedMessage(jobs?.length ?? paths.length, noun[0], noun[1]), tone: "success" });
    return { ok: true, inputErrors: {} };
  } catch (e) {
    const err = toAppError(e);
    const inputErrors = mapInputErrors(err.fields, paths);
    if (Object.keys(inputErrors).length > 0) {
      toast({ title: "Some files can't be processed", description: "See the file list for details.", tone: "danger" });
    } else {
      toast({ title: err.message, description: err.hint, tone: "danger" });
    }
    return { ok: false, inputErrors };
  }
}
