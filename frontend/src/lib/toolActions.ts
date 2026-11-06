/**
 * Cross-tool wiring (Phase 11, SPEC §3.4). Code outside a tool never imports
 * that tool's files: the composition root (`tools/index.ts`) registers the
 * tool views and the few cross-tool actions here, with dynamic imports, and
 * callers (the editor, the Library, components such as <ToolClickIn>) look
 * them up. This keeps the dependency direction `tools → blocks/lib/components`
 * enforced by `src/architecture.test.ts`.
 */
import type { ComponentType, LazyExoticComponent } from "react";

/** Props every tool view receives (re-exported by `tools/index.ts`). */
export interface ToolViewProps {
  moduleId: string;
}

export type ToolView = LazyExoticComponent<ComponentType<ToolViewProps>> | ComponentType<ToolViewProps>;

/** Actions one tool offers to the rest of the app. Add a key here, register it in `tools/index.ts`. */
export interface ToolActions {
  /** Post Builder: "Add to post…" for a file (opens its dialog). */
  addToPost(path: string): Promise<void>;
}

let views: Record<string, ToolView> = {};
let actions: Partial<ToolActions> = {};

/** Called once by `tools/index.ts`. */
export function registerToolViews(v: Record<string, ToolView>): void {
  views = { ...views, ...v };
}

/** The view of a module, or undefined (no UI: the ComingSoon view). */
export function getToolView(moduleId: string): ToolView | undefined {
  return views[moduleId];
}

/** Called once by `tools/index.ts` (tests may register fakes). */
export function registerToolActions(a: Partial<ToolActions>): void {
  actions = { ...actions, ...a };
}

/** Runs a registered action; a missing one (a test without the tools) is a no-op. */
export function toolAction<K extends keyof ToolActions>(key: K): ToolActions[K] {
  const fn = actions[key];
  if (fn) return fn;
  return (async () => undefined) as unknown as ToolActions[K];
}
