import { beforeEach, describe, expect, it, vi } from "vitest";

const w = vi.hoisted(() => ({ kind: "main" as string, popOutTool: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/windows", () => ({
  currentWindow: () => ({ kind: w.kind, key: w.kind === "main" ? "main" : "tool:x", view: "", part: "", params: new URLSearchParams() }),
  popOutTool: w.popOutTool,
}));

import { useUI } from "@/state/ui";
import { openTool, openToolItems } from "./openTool";

describe("openTool", () => {
  beforeEach(() => {
    w.kind = "main";
    w.popOutTool.mockClear();
    useUI.setState({ view: "library", handoff: null });
  });

  it("hands off in the main window", async () => {
    await openTool("bg-remover", ["/a.png"]);
    expect(useUI.getState().view).toBe("bg-remover");
    expect(useUI.getState().handoff).toEqual({ moduleId: "bg-remover", inputs: ["/a.png"] });
    expect(w.popOutTool).not.toHaveBeenCalled();
  });

  it("navigates without inputs", async () => {
    await openTool("trimmer");
    expect(useUI.getState().view).toBe("trimmer");
    expect(useUI.getState().handoff).toBeNull();
  });

  it("pops out with the handoff when asked", async () => {
    await openTool("bg-remover", ["/a.png"], {}, { window: true });
    expect(w.popOutTool).toHaveBeenCalledWith("bg-remover", expect.objectContaining({ handoff: { moduleId: "bg-remover", inputs: ["/a.png"] } }));
    expect(useUI.getState().view).toBe("library");
  });

  it("always pops out from a pop-out window", async () => {
    w.kind = "tool";
    await openTool("trimmer", ["/v.mp4"]);
    expect(w.popOutTool).toHaveBeenCalledTimes(1);
  });

  it("carries an action through the handoff and the pop-out", async () => {
    await openTool("pdf", ["/a.pdf"], { action: "compress" });
    expect(useUI.getState().handoff).toEqual({ moduleId: "pdf", inputs: ["/a.pdf"], action: "compress" });
    await openTool("pdf", ["/a.pdf"], { action: "compress" }, { window: true });
    expect(w.popOutTool).toHaveBeenCalledWith("pdf", expect.objectContaining({ handoff: { moduleId: "pdf", inputs: ["/a.pdf"], action: "compress" } }));
  });

  it("builds a pair of menu items", () => {
    const items = openToolItems("trimmer", ["/v.mp4"]);
    expect(items.map((i) => i.id)).toEqual(["open-trimmer", "open-trimmer-window"]);
  });
});
