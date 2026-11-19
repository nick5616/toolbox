import { useWorkspace } from "@/state/workspace";
import { PRESENTER_OFF, currentPresenter, rewritePath, rewriteText } from "./pathRewrite";

export { rewritePath, rewriteText, type Presenter } from "./pathRewrite";

/**
 * `displayPath(p)` (SPEC A5): inside the workspace root -> `<Name>/…`, inside home -> `~/…`,
 * else unchanged; unchanged when "Hide personal details" is off. A plain function: use
 * `useDisplayPath` where the component must re-render when the presenter changes.
 */
export function displayPath(p: string): string {
  return rewritePath(p, currentPresenter());
}

/** The same rewrite for every path inside free text (messages, hints, log lines). */
export function displayText(s: string): string {
  return rewriteText(s, currentPresenter());
}

/** Subscribes the component to presenter changes and returns `displayPath`. */
export function useDisplayPath(): (p: string) => string {
  const pr = useWorkspace((s) => s.presenter);
  return (p: string) => rewritePath(p, pr ?? PRESENTER_OFF);
}
