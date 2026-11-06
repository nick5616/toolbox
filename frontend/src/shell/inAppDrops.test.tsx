import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ModuleStatus, type Descriptor } from "@/lib/api";
import { DropZone } from "@/components";
import { PATHS_MIME } from "@/lib/fileDrag";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { usePipelines } from "@/state/pipelines";
import { installInAppDrops } from "./dropRouting";

function mod(id: string): Descriptor {
  return { id, name: id, tagline: "", description: "", icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [".mp3"], urls: false }, requires: null, recommends: null } as Descriptor;
}

function dt(paths: string[] | null) {
  const data: Record<string, string> = paths ? { [PATHS_MIME]: JSON.stringify(paths) } : {};
  return { types: paths ? [PATHS_MIME] : ["Files"], getData: (k: string) => data[k] ?? "", dropEffect: "" };
}

let uninstall: () => void;
beforeEach(() => {
  // The Wails runtime's own (OS file) dragover listener calls this.
  document.elementFromPoint = () => null;
  usePipelines.setState({
    entries: [{ pipeline: { id: "p1", name: "P" }, check: { ready: false, accepts: [], secrets: [] } }],
  } as never);
  useModules.getState().setAll([mod("stems")]);
  useUI.setState({ drop: null, handoff: null, view: "library" });
  uninstall = installInAppDrops();
});
afterEach(() => {
  uninstall();
  cleanup();
});

const zoneOf = (c: HTMLElement) => c.querySelector("[id='tool-drop:stems']")!;

describe("in-app drops", () => {
  it("hands files dropped on a DropZone to that tool and highlights it while over", () => {
    const { container } = render(<DropZone id="tool-drop:stems" />);
    const zone = zoneOf(container);
    fireEvent.dragOver(zone, { dataTransfer: dt(["/a.mp3", "/b.txt"]) });
    expect(zone.classList.contains("file-drop-target-active")).toBe(true);
    fireEvent.drop(zone, { dataTransfer: dt(["/a.mp3", "/b.txt"]) });
    expect(zone.classList.contains("file-drop-target-active")).toBe(false);
    expect(useUI.getState().handoff).toEqual({ moduleId: "stems", inputs: ["/a.mp3"] });
  });

  it("a drop inside a pipeline card opens the run sheet", () => {
    const { container } = render(
      <div id="pipeline-drop:p1" data-file-drop-target="">
        <span data-testid="inner">card</span>
      </div>,
    );
    const calls: unknown[] = [];
    const orig = usePipelines.getState().openRunSheet;
    usePipelines.setState({ openRunSheet: (id: string, inputs: string[]) => calls.push([id, inputs]) } as never);
    try {
      fireEvent.drop(container.querySelector("[data-testid=inner]")!, { dataTransfer: dt(["/a.mp3"]) });
    } finally {
      usePipelines.setState({ openRunSheet: orig } as never);
    }
    expect(calls).toEqual([["p1", ["/a.mp3"]]]);
  });

  it("leaves OS file drags alone", () => {
    const { container } = render(<DropZone id="tool-drop:stems" />);
    const zone = zoneOf(container);
    fireEvent.dragOver(zone, { dataTransfer: dt(null) });
    expect(document.documentElement.hasAttribute("data-inapp-drag")).toBe(false);
    fireEvent.drop(zone, { dataTransfer: dt(null) });
    expect(useUI.getState().handoff).toBeNull();
    expect(zone.classList.contains("file-drop-target-active")).toBe(false);
  });

  it("Escape clears the highlight", () => {
    const { container } = render(<DropZone id="tool-drop:stems" />);
    const zone = zoneOf(container);
    fireEvent.dragOver(zone, { dataTransfer: dt(["/a.mp3"]) });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(zone.classList.contains("file-drop-target-active")).toBe(false);
    expect(document.documentElement.hasAttribute("data-inapp-drag")).toBe(false);
  });
  it("clears a highlight left behind by an OS drag on the next mouse move", () => {
    const { container } = render(<div id="app-root" data-file-drop-target="" />);
    const root = container.querySelector("#app-root")!;
    // What the Wails runtime does on an OS drag over the window, then never undoes.
    root.classList.add("file-drop-target-active");
    fireEvent.pointerMove(document.body);
    expect(root.classList.contains("file-drop-target-active")).toBe(false);
  });

  it("clears it when an OS drag leaves a WebView2 window", () => {
    const { container } = render(<div id="app-root" data-file-drop-target="" />);
    const root = container.querySelector("#app-root")!;
    root.classList.add("file-drop-target-active");
    const w = window as Window & { chrome?: { webview?: unknown } };
    w.chrome = { webview: {} };
    try {
      fireEvent.dragLeave(root, { dataTransfer: dt(null), relatedTarget: null });
    } finally {
      delete w.chrome;
    }
    expect(root.classList.contains("file-drop-target-active")).toBe(false);
  });
});
