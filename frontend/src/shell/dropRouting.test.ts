import { beforeEach, describe, expect, it } from "vitest";
import { ModuleStatus, type Descriptor, type FilesDropped } from "@/lib/api";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { ownsDrop, routeFilesDropped } from "./dropRouting";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";

function mod(id: string, status = ModuleStatus.StatusReady): Descriptor {
  return { id, name: id, tagline: "", description: "", icon: "box", status, accepts: { extensions: [".mp3"], urls: false }, requires: null, recommends: null } as Descriptor;
}

function drop(targetId: string, paths: string[]): FilesDropped {
  return { paths, targetId, result: { matches: null, unmatched: null } } as FilesDropped;
}

describe("routeFilesDropped", () => {
  beforeEach(() => {
    useModules.getState().setAll([mod("stems"), mod("soon", ModuleStatus.StatusComingSoon)]);
    useUI.setState({ drop: null, handoff: null, view: "library" });
  });

  it("hands accepted paths straight to a tool-drop target", () => {
    routeFilesDropped(drop("tool-drop:stems", ["/a.mp3", "/b.txt"]));
    expect(useUI.getState().drop).toBeNull();
    expect(useUI.getState().handoff).toEqual({ moduleId: "stems", inputs: ["/a.mp3"] });
    expect(useUI.getState().view).toBe("stems");
  });

  it("opens the chooser for other targets", () => {
    const d = drop("", ["/a.mp3"]);
    routeFilesDropped(d);
    expect(useUI.getState().drop).toBe(d);
    expect(useUI.getState().handoff).toBeNull();
  });

  it("hands files dropped anywhere on a tool's page to that tool when it accepts them", () => {
    useUI.setState({ view: "stems" });
    routeFilesDropped(drop("", ["/a.mp3", "/b.txt"]));
    expect(useUI.getState().drop).toBeNull();
    expect(useUI.getState().handoff).toEqual({ moduleId: "stems", inputs: ["/a.mp3"] });
  });

  it("opens the chooser on a tool's page when the tool can't use the files", () => {
    useUI.setState({ view: "stems" });
    const d = drop("", ["/a.txt"]);
    routeFilesDropped(d);
    expect(useUI.getState().drop).toBe(d);
    expect(useUI.getState().handoff).toBeNull();
  });

  it("never hands files to a page whose tool takes no files", () => {
    useModules.getState().setAll([{ ...mod("pipelines"), accepts: { extensions: [], urls: false, any: false } } as Descriptor]);
    useUI.setState({ view: "pipelines" });
    const d = drop("", ["/a.mp3"]);
    routeFilesDropped(d);
    expect(useUI.getState().drop).toBe(d);
  });

  it("opens the chooser when nothing is accepted or the module is not ready", () => {
    routeFilesDropped(drop("tool-drop:stems", ["/a.txt"]));
    expect(useUI.getState().drop).not.toBeNull();
    useUI.setState({ drop: null });
    routeFilesDropped(drop("tool-drop:soon", ["/a.mp3"]));
    expect(useUI.getState().drop).not.toBeNull();
    expect(useUI.getState().handoff).toBeNull();
  });
});

describe("drops in pop-out windows", () => {
  it("ownsDrop matches the window key (main = empty)", () => {
    expect(ownsDrop({ window: "" }, "main")).toBe(true);
    expect(ownsDrop({ window: "tool:stems" }, "main")).toBe(false);
    expect(ownsDrop({ window: "tool:stems" }, "tool:stems")).toBe(true);
    expect(ownsDrop({ window: "" }, "tool:stems")).toBe(false);
  });

  it("a tool window routes only its own drops, to its tool", () => {
    useModules.getState().setAll([mod("stems")]);
    useUI.setState({ drop: null, handoff: null, view: "stems" });
    setCurrentWindowForTest(parseWindow("?window=tool&view=stems&key=tool:stems"));
    try {
      const other = { ...drop("", ["/a.mp3"]), window: "" } as FilesDropped;
      routeFilesDropped(other);
      expect(useUI.getState().handoff).toBeNull();
      expect(useUI.getState().drop).toBeNull();
      routeFilesDropped({ ...drop("", ["/a.mp3"]), window: "tool:stems" } as FilesDropped);
      expect(useUI.getState().handoff).toEqual({ moduleId: "stems", inputs: ["/a.mp3"] });
    } finally {
      setCurrentWindowForTest(null);
    }
  });
});

describe("custom drop targets (Phase 13)", () => {
  it("hands a drop on a claimed target to its handler and nothing else", async () => {
    const { registerDropTarget } = await import("@/lib/dropTargets");
    const got: Array<[string, string[]]> = [];
    const off = registerDropTarget("lan-device:", (fp, paths) => got.push([fp, paths]));
    routeFilesDropped({ paths: ["/a.jpg"], targetId: "lan-device:abc", window: "", result: { matches: null, unmatched: null } });
    off();
    routeFilesDropped({ paths: ["/b.jpg"], targetId: "lan-device:abc", window: "", result: { matches: null, unmatched: null } });
    expect(got).toEqual([["abc", ["/a.jpg"]]]);
  });
});
