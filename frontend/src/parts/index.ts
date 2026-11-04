// Side-effect imports of every tool's part definitions: `tools/<tool>/parts.ts`
// (definePart calls) and `tools/<tool>/workspace.ts(x)` (defineWorkspace,
// Phase 11). Discovered by glob so adding a tool's parts needs no edit here.
import.meta.glob(["../tools/*/parts.ts", "../tools/*/workspace.ts", "../tools/*/workspace.tsx"], { eager: true });
export { definePart, getPart, listParts } from "./registry";
export type { PartProps, PartSpec } from "./types";
