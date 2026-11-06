import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: "",
  fromTemplate: vi.fn(async (id: string) => ({ id: "", name: id, templateId: id })),
  save: vi.fn(async () => ({})),
  setState: vi.fn(async (_k: string, v: string) => {
    h.state = v;
  }),
}));

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return {
    ...real,
    PipelinesService: { ...real.PipelinesService, FromTemplate: h.fromTemplate, Save: h.save, List: async () => [], Runs: async () => [], Catalog: async () => [], Templates: async () => [] },
    SettingsService: { ...real.SettingsService, ModuleState: async () => h.state, SetModuleState: h.setState },
  };
});

import { usePipelines } from "@/state/pipelines";
import { resetSeedForTest, seedWorkflowPipelines, WORKFLOW_TEMPLATES } from "./seedWorkflows";

describe("seedWorkflowPipelines", () => {
  beforeEach(() => {
    h.state = "";
    h.fromTemplate.mockClear();
    h.save.mockClear();
    resetSeedForTest();
    usePipelines.setState({ entries: [] });
  });

  it("saves every workflow template once and records that it ran", async () => {
    expect(await seedWorkflowPipelines()).toBe(WORKFLOW_TEMPLATES.length);
    expect(h.save).toHaveBeenCalledTimes(WORKFLOW_TEMPLATES.length);
    expect(h.state).not.toBe("");
    resetSeedForTest();
    expect(await seedWorkflowPipelines()).toBe(0);
    expect(h.save).toHaveBeenCalledTimes(WORKFLOW_TEMPLATES.length);
  });
});
