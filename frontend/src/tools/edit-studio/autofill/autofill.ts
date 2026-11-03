/** The auto-fill engine (§13.2). Wave 0 stub (owned by WP-ES6); the props are frozen. */
import type { AutofillInput, AutofillResult } from "./types";

/** Pure and deterministic: same input, same clips. */
export function autofill(input: AutofillInput): AutofillResult {
  return { trackId: input.options.trackId, clips: [], removed: [], warnings: ["Auto-fill isn't built yet"] };
}
