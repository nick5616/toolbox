import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  paint: {} as ReturnType<typeof import("./testing/env").paintServiceMock>,
}));

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return {
    ...real,
    PaintService: new Proxy({}, { get: (_t, k: string) => (h.paint as Record<string, unknown>)[k] }),
    SettingsService: { ...real.SettingsService, ModuleState: async () => "", SetModuleState: async () => undefined },
    FilesService: { ...real.FilesService, PickWith: async () => [] },
  };
});

import { JobStatus } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import Editor from "./Editor";
import { setRuntime } from "./engine-adapter";
import { needsFrontendFlatten } from "./exportFlow";
import { usePaintUI } from "./store";
import { FakeEngine } from "./testing/fakeEngine";
import { paintServiceMock, sampleDoc, setViewport } from "./testing/env";

const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key: k, ...init });

async function openEditor() {
  const view = render(<Editor projectId="p1" initialName="Sunset" studio={false} onToggleStudio={() => undefined} onBack={() => undefined} onOpen={() => undefined} imports={[]} onImportsDone={() => undefined} />);
  await screen.findByTestId("top-left");
  return view;
}

beforeEach(() => {
  setViewport(1400, 800);
  h.paint = paintServiceMock();
  usePaintUI.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Editor", () => {
  it("renders the canvas, the islands and the project name", async () => {
    await openEditor();
    expect(screen.getByTestId("paint-canvas")).toBeTruthy();
    expect(screen.getByTestId("top-right")).toBeTruthy();
    expect(screen.getByTestId("left-edge")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Painting name" }) as HTMLInputElement).value).toBe("Sunset");
    expect(h.paint.Load).toHaveBeenCalledWith("p1");
  });

  it("switches tools with the keys and changes size and opacity", async () => {
    await openEditor();
    const ui = usePaintUI.getState;
    key("e");
    expect(ui().tool).toBe("eraser");
    key("s");
    expect(ui().tool).toBe("smudge");
    key("b");
    expect(ui().tool).toBe("brush");
    key("g");
    expect(ui().tool).toBe("fill");
    key("i");
    expect(ui().tool).toBe("eyedropper");
    key("m");
    expect(ui().tool).toBe("rect");
    key("l");
    expect(ui().tool).toBe("lasso");
    key("w");
    expect(ui().tool).toBe("wand");
    key("b");
    const size = ui().size;
    key("]");
    expect(ui().size).toBeGreaterThan(size);
    key("[");
    key("[");
    expect(ui().size).toBeLessThan(size);
    const o = ui().opacity;
    key("{");
    expect(ui().opacity).toBeLessThan(o);
    expect(screen.getByTestId("brush-hud")).toBeTruthy();
  });

  it("Tab hides the interface and F asks for Studio mode", async () => {
    const toggle = vi.fn();
    render(<Editor projectId="p1" initialName="Sunset" studio={false} onToggleStudio={toggle} onBack={() => undefined} onOpen={() => undefined} imports={[]} onImportsDone={() => undefined} />);
    await screen.findByTestId("top-left");
    key("Tab");
    expect(usePaintUI.getState().uiHidden).toBe(true);
    key("Tab");
    expect(usePaintUI.getState().uiHidden).toBe(false);
    key("f");
    expect(toggle).toHaveBeenCalled();
  });

  it("docks panels at 1600 px and above, and floats them as popovers below", async () => {
    setViewport(1700, 900);
    const { unmount } = await openEditor();
    act(() => usePaintUI.getState().openPanel("layers"));
    expect(screen.getByTestId("dock")).toBeTruthy();
    expect(screen.getByTestId("paint-editor").getAttribute("data-docked")).toBe("true");
    expect(screen.queryByTestId("popover-layers")).toBeNull();
    unmount();

    setViewport(1300, 800);
    usePaintUI.getState().reset();
    await openEditor();
    act(() => usePaintUI.getState().openPanel("layers"));
    expect(screen.getByTestId("popover-layers")).toBeTruthy();
    expect(screen.queryByTestId("dock")).toBeNull();
  });

  it("the dock can be overridden to always float or always dock", async () => {
    setViewport(1700, 900);
    await openEditor();
    act(() => {
      usePaintUI.getState().setDockMode("pop");
      usePaintUI.getState().openPanel("layers");
    });
    expect(screen.getByTestId("popover-layers")).toBeTruthy();
  });

  it("is compact at 960 x 600 with 3 Lab tools in the strip, and 6 at full size", async () => {
    setViewport(960, 600);
    const { unmount } = await openEditor();
    expect(screen.getByTestId("paint-editor").getAttribute("data-compact")).toBe("true");
    const strip = screen.getByTestId("lab-strip");
    expect(strip.querySelectorAll('[data-testid^="badge-"]')).toHaveLength(3);
    unmount();
    setViewport(1920, 1080);
    await openEditor();
    expect(screen.getByTestId("paint-editor").getAttribute("data-compact")).toBe("false");
    expect(screen.getByTestId("lab-strip").querySelectorAll('[data-testid^="badge-"]')).toHaveLength(6);
  });

  it("Lab panel shows predictability badges and origin cards on demand", async () => {
    await openEditor();
    act(() => usePaintUI.getState().openPanel("lab"));
    const device = await screen.findByTestId("device-flow-field");
    expect(within(device).getByTestId("badge-seeded")).toBeTruthy();
    expect(within(device).queryByTestId("origin-card")).toBeNull();
    fireEvent.click(within(device).getByRole("button", { name: "About Flow field" }));
    expect(within(device).getByTestId("origin-card").textContent).toMatch(/no training data/i);
    const exact = screen.getByTestId("device-pixel-sort");
    expect(within(exact).getByTestId("badge-exact")).toBeTruthy();
    expect(within(exact).queryByTestId("seed-pixel-sort")).toBeNull(); // exact tools have no seed
    expect(within(device).getByTestId("seed-flow-field")).toBeTruthy();
  });

  it("the gate disables perception tools with a reason and shows one banner", async () => {
    h.paint.AIStatus.mockResolvedValue([{ tool: "fill", ready: false, needs: ["engine"], reason: "The AI engine isn't installed", modelSize: 0 }, { tool: "segment", ready: true, needs: [], reason: "", modelSize: 0 }]);
    await openEditor();
    act(() => usePaintUI.getState().openPanel("lab"));
    const dissolve = await screen.findByTestId("device-dissolve");
    await waitFor(() => expect(dissolve.getAttribute("data-disabled")).toBe("true"));
    const name = within(dissolve).getByRole("button", { name: "Dissolve" });
    expect(name.getAttribute("aria-disabled")).toBe("true");
    expect(name.getAttribute("data-tip")).toMatch(/AI engine isn't installed/);
    expect(screen.getAllByTestId("gate-banner")).toHaveLength(1);
    expect(screen.getByTestId("device-flow-field").getAttribute("data-disabled")).toBeNull();
    // a ready perception tool is not gated
    expect(screen.getByTestId("device-select-object").getAttribute("data-disabled")).toBeNull();
    // clicking a gated tool does not pick it
    fireEvent.click(name);
    expect(usePaintUI.getState().tool).not.toBe("lab");
  });

  it("picking a Lab tool makes it the tool in hand", async () => {
    await openEditor();
    act(() => usePaintUI.getState().openPanel("lab"));
    const device = await screen.findByTestId("device-flow-field");
    fireEvent.click(within(device).getByRole("button", { name: "Flow field" }));
    expect(usePaintUI.getState().tool).toBe("lab");
    expect(usePaintUI.getState().labToolId).toBe("flow-field");
    expect(usePaintUI.getState().labRecent[0]).toBe("flow-field");
  });

  it("imports brushes and shows the fidelity notes", async () => {
    h.paint.PickBrushFiles.mockResolvedValue(["C:/brushes/inks.brushset"]);
    h.paint.ImportBrushes.mockResolvedValue([{ file: "C:/brushes/inks.brushset", set: { id: "inks", name: "Inks", source: "procreate", brushes: [{ id: "a", name: "A", set: "inks", credit: "", license: "" }], imported: 1 }, fidelity: ["Spacing approximated", "Grain scale approximated"], error: "" }]);
    await openEditor();
    act(() => usePaintUI.getState().openPanel("brushes"));
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    const notes = await screen.findByLabelText("Fidelity notes");
    expect(notes.textContent).toMatch(/Spacing approximated/);
    expect(notes.textContent).toMatch(/Grain scale approximated/);
    expect(screen.getByTestId("import-notes").textContent).toMatch(/Inks \(1 brushes\)/);
  });

  it("every control has a tooltip or a label", async () => {
    setViewport(1700, 900);
    await openEditor();
    act(() => {
      for (const p of ["brushes", "layers", "color"] as const) usePaintUI.getState().openPanel(p);
    });
    await screen.findByTestId("dock");
    const bad: string[] = [];
    for (const el of screen.getByTestId("paint-editor").querySelectorAll("button, [role=slider], [role=switch], [role=radio], [role=tab], input, select")) {
      if (!(el.getAttribute("data-tip") || el.getAttribute("aria-label") || el.getAttribute("title"))) bad.push(el.outerHTML.slice(0, 120));
    }
    expect(bad).toEqual([]);
  });
});

describe("Export", () => {
  it("sends the options and shows LastExport when the job finishes", async () => {
    await openEditor();
    key("E", { ctrlKey: true, shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Export" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "JPG" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.paint.Export).toHaveBeenCalled());
    const opts = h.paint.Export.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.projectId).toBe("p1");
    expect(opts.format).toBe("jpg");
    expect(opts.scale).toBe(1);
    expect(opts.flattened).toBe("");
    await waitFor(() => expect(screen.getByTestId("export-running")).toBeTruthy());
    act(() =>
      useJobs.getState().upsert({
        id: "job1",
        moduleId: "paint",
        status: JobStatus.JobDone,
        outputs: [{ id: "o1", jobId: "job1", moduleId: "paint", path: "C:/Toolbox/Paintings/Sunset.jpg", name: "Sunset.jpg", kind: "image", sizeBytes: 10, createdAt: 1, tags: [], missing: false }],
        inputs: [],
        error: "",
      } as never),
    );
    const row = await screen.findByTestId("last-export");
    expect(row.textContent).toMatch(/Sunset\.jpg/);
  });

  it("flattens in the frontend when a layer uses a blend mode Go can't", () => {
    const doc = sampleDoc(2);
    expect(needsFrontendFlatten(doc)).toBe(false);
    doc.layers[1] = { ...doc.layers[1]!, blend: "color-dodge" };
    expect(needsFrontendFlatten(doc)).toBe(true);
    doc.layers[1] = { ...doc.layers[1]!, hidden: true };
    expect(needsFrontendFlatten(doc)).toBe(false); // hidden layers don't count
  });

  it("passes Flattened for such a canvas", async () => {
    const doc = sampleDoc(2);
    doc.layers[1] = { ...doc.layers[1]!, blend: "soft-light" };
    h.paint.Load.mockResolvedValue(doc);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => undefined } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,QUJD");
    await openEditor();
    key("E", { ctrlKey: true, shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Export" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.paint.Export).toHaveBeenCalled());
    expect((h.paint.Export.mock.calls[0]?.[0] as unknown as { flattened: string }).flattened).toBe("data:image/png;base64,QUJD");
  });

  it("ORA keeps layers and sends no flattened picture", async () => {
    const doc = sampleDoc(2);
    doc.layers[1] = { ...doc.layers[1]!, blend: "soft-light" };
    h.paint.Load.mockResolvedValue(doc);
    await openEditor();
    key("E", { ctrlKey: true, shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Export" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "ORA" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.paint.Export).toHaveBeenCalled());
    expect((h.paint.Export.mock.calls[0]?.[0] as unknown as { flattened: string }).flattened).toBe("");
  });
});

describe("the engine seam", () => {
  it("uses whatever engine the runtime provides", async () => {
    const created = vi.fn(() => new FakeEngine());
    const restore = setRuntime({ createEngine: created });
    try {
      await openEditor();
      expect(created).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
