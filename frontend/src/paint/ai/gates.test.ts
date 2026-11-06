import { describe, expect, it, vi } from "vitest";
import { mapGates, summarizeGates, warmOnce, resetWarm } from "./gates";
import { PERCEPTION_TOOLS } from "./tools";
import { PaintService } from "@/lib/api";

describe("gate mapping", () => {
  it("maps each tool to its operation's status", () => {
    const gates = mapGates([
      { tool: "fill", ready: true, needs: null, reason: "", modelSize: 0 },
      { tool: "cutout", ready: false, needs: ["birefnet"], reason: "The cut-out model isn't installed", modelSize: 100 },
      { tool: "segment", ready: false, needs: ["sam2", "audio-engine"], reason: "The AI engine isn't installed", modelSize: 50 },
    ]);
    expect(gates["dissolve"]).toMatchObject({ ready: true, reason: "" });
    expect(gates["extend-canvas"]!.ready).toBe(true);
    expect(gates["subject-stamp"]).toMatchObject({ ready: false, needs: ["birefnet"], modelSize: 100 });
    expect(gates["select-object"]!.needs).toEqual(["sam2", "audio-engine"]);
    // enhance wasn't reported
    expect(gates["enhance-brush"]!.ready).toBe(false);
    expect(Object.keys(gates).sort()).toEqual(PERCEPTION_TOOLS.map((t) => t.id).sort());
  });
  it("is blocked with a checking reason until the status loads", () => {
    const gates = mapGates(null);
    expect(gates["dissolve"]!.ready).toBe(false);
    expect(gates["dissolve"]!.reason).toMatch(/Checking/);
  });
  it("summarizes distinct needs and counts bytes once per operation", () => {
    const s = summarizeGates(
      mapGates([
        { tool: "fill", ready: false, needs: ["lama"], reason: "LaMa missing", modelSize: 200 },
        { tool: "cutout", ready: true, needs: null, reason: "", modelSize: 0 },
        { tool: "segment", ready: true, needs: null, reason: "", modelSize: 0 },
        { tool: "enhance", ready: true, needs: null, reason: "", modelSize: 0 },
      ]),
    );
    expect(s.needs).toEqual(["lama"]);
    expect(s.bytes).toBe(200);
    expect(s.reasons).toEqual(["LaMa missing"]);
    expect(s.blocked).toBe(PERCEPTION_TOOLS.filter((t) => t.op === "fill").length);
  });
});

describe("warmOnce", () => {
  it("warms the engine a single time", () => {
    resetWarm();
    const spy = vi.spyOn(PaintService, "Warm").mockResolvedValue(undefined as never);
    warmOnce();
    warmOnce();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
