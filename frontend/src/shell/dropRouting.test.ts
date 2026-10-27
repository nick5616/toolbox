import { beforeEach, describe, expect, it } from "vitest";
import { ModuleStatus, type Descriptor, type FilesDropped } from "@/lib/api";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { routeFilesDropped } from "./dropRouting";

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

  it("opens the chooser when nothing is accepted or the module is not ready", () => {
    routeFilesDropped(drop("tool-drop:stems", ["/a.txt"]));
    expect(useUI.getState().drop).not.toBeNull();
    useUI.setState({ drop: null });
    routeFilesDropped(drop("tool-drop:soon", ["/a.mp3"]));
    expect(useUI.getState().drop).not.toBeNull();
    expect(useUI.getState().handoff).toBeNull();
  });
});
