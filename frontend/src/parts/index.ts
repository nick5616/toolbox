// Side-effect imports of every tool's part definitions (`tools/<tool>/parts.ts`
// or `editor/parts.ts`). Each file calls `definePart(...)` from "@/parts/registry".
import "@/tools/video-studio/parts";
import "@/tools/edit-studio/parts";
import "@/tools/visualizer/parts";
export { definePart, getPart, listParts } from "./registry";
export type { PartProps, PartSpec } from "./types";
