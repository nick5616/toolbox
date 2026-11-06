// The algorithmic Lab tools (Phase 19, SPEC 1.4.1). The architect wires them
// into the engine with registerAll(registerLabTool).

import { createEcho } from "./echo";
import { createFeedback } from "./feedback";
import { createFlowField } from "./flowfield";
import { createGrowth } from "./growth";
import { createInkBleed } from "./inkbleed";
import { createParticles } from "./particles";
import { createPixelSort } from "./pixelsort";
import { POST_TOOLS } from "./postTools";
import { createReactionDiffusion } from "./reactiondiffusion";
import { createSmear } from "./smear";
import type { AsyncLabTool } from "./ext";
import { createVoronoi } from "./voronoi";
import type { LabTool } from "./types";

export const ALGORITHMIC_TOOLS: AsyncLabTool[] = [
  createFlowField(),
  createGrowth(),
  createReactionDiffusion(),
  createInkBleed(),
  createParticles(),
  createPixelSort(),
  createSmear(),
  createFeedback(),
  createEcho(),
  createVoronoi(),
  ...POST_TOOLS,
];

export function registerAll(register: (t: LabTool) => void): void {
  for (const t of ALGORITHMIC_TOOLS) register(t);
}

export { flushTool } from "./ext";
export type { AsyncLabTool, DabStyle, LabContextExt, LabContextX } from "./ext";
export { POST_TOOLS } from "./postTools";
