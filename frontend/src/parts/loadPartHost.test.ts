import { describe, expect, it, vi } from "vitest";
import { loadPartHost } from "@/parts";
import { getPart } from "@/parts/registry";
import { preloadToolView, registerToolPreload } from "@/lib/toolActions";

describe("loadPartHost", () => {
  it("registers only the tool a part id belongs to, mapping module ids to folders", async () => {
    expect(getPart("dev-utils.panel")).toBeUndefined();
    await loadPartHost("dev-utils.panel");
    expect(getPart("dev-utils.panel")).toBeDefined();
    // Another tool's parts were not pulled in.
    expect(getPart("pipelines.panel")).toBeUndefined();
    // Idempotent.
    await loadPartHost("dev-utils.panel");
  });
});

describe("preloadToolView", () => {
  it("calls the registered loader and swallows failures", async () => {
    const load = vi.fn((id: string) => (id === "bad" ? Promise.reject(new Error("offline")) : Promise.resolve()));
    registerToolPreload(load);
    preloadToolView("stems");
    preloadToolView("bad");
    await Promise.resolve();
    expect(load).toHaveBeenCalledWith("stems");
    expect(load).toHaveBeenCalledWith("bad");
    registerToolPreload(() => {
      throw new Error("boom");
    });
    expect(() => preloadToolView("x")).not.toThrow();
  });
});
