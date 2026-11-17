// Part definitions are registered by `tools/<tool>/parts.ts` (definePart calls)
// and `tools/<tool>/workspace.ts(x)` (defineWorkspace, Phase 11). They load
// lazily: only a part window needs them before its tool has opened, so
// `loadPartHost` imports just the tool a part id belongs to. In the main
// window a tool's view imports its own workspace.
import { getPart } from "./registry";

const loaders = import.meta.glob(["../tools/*/parts.ts", "../tools/*/workspace.ts", "../tools/*/workspace.tsx"]);

/** Module ids whose folder under `tools/` has a different name. */
const FOLDER_OF: Record<string, string> = { "lyric-video": "lyricvideo", "dev-utils": "devutils" };

/** The workspace/part files of the tool whose module id prefixes `partId` (all tools if none match). */
function loadersFor(partId: string): Array<() => Promise<unknown>> {
  const module = partId.split(".")[0] ?? "";
  const folder = FOLDER_OF[module] ?? module;
  const own = Object.entries(loaders).filter(([path]) => path.startsWith(`../tools/${folder}/`));
  return (own.length > 0 ? own : Object.entries(loaders)).map(([, load]) => load);
}

/** Registers the parts a part id needs (idempotent; imports are cached). */
export async function loadPartHost(partId: string): Promise<void> {
  if (getPart(partId)) return;
  await Promise.all(loadersFor(partId).map((load) => load()));
}

export { definePart, getPart, listParts } from "./registry";
export type { PartProps, PartSpec } from "./types";
