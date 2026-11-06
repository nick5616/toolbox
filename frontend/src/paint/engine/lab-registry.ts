// The registry P2 fills with algorithmic Lab tools (SPEC §1.4.1). The engine
// routes ToolState.kind === "lab" to the tool registered under toolId.

import type { LabTool } from "../lab/types";

const tools = new Map<string, LabTool>();

export function registerLabTool(tool: LabTool): void {
  tools.set(tool.id, tool);
}

export function getLabTool(id: string): LabTool | undefined {
  return tools.get(id);
}

export function listLabTools(): LabTool[] {
  return [...tools.values()];
}

/** Tests only. */
export function clearLabTools(): void {
  tools.clear();
}
