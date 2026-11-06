import { describe, expect, it } from "vitest";
import { PATHS_MIME, TOOL_MIME, hasPaths, hasTool, readPaths, readTool, startPathsDrag, startToolDrag } from "./fileDrag";

function fakeDT() {
  const data: Record<string, string> = {};
  return {
    data,
    dt: {
      get types() {
        return Object.keys(data);
      },
      setData: (k: string, v: string) => {
        data[k] = v;
      },
      getData: (k: string) => data[k] ?? "",
      effectAllowed: "",
    },
  };
}
const ev = (dt: unknown) => ({ dataTransfer: dt }) as unknown as DragEvent;

describe("fileDrag", () => {
  it("round-trips paths and sets a uri-list", () => {
    const { dt, data } = fakeDT();
    const e = ev(dt);
    startPathsDrag(e, ["C:\\a b\\x.mp3", "/y.png"]);
    expect(hasPaths(e)).toBe(true);
    expect(hasTool(e)).toBe(false);
    expect(readPaths(e)).toEqual(["C:\\a b\\x.mp3", "/y.png"]);
    expect(data["text/uri-list"]).toContain("file:///C:/a%20b/x.mp3");
  });

  it("ignores an empty list", () => {
    const { dt } = fakeDT();
    startPathsDrag(ev(dt), []);
    expect(hasPaths(ev(dt))).toBe(false);
  });

  it("round-trips a tool", () => {
    const { dt } = fakeDT();
    const e = ev(dt);
    startToolDrag(e, "stems");
    expect(hasTool(e)).toBe(true);
    expect(readTool(e)).toBe("stems");
  });

  it("returns null for bad or missing JSON", () => {
    for (const bad of ["", "{", "{}", "[1,2]"]) {
      const { dt, data } = fakeDT();
      data[PATHS_MIME] = bad;
      expect(readPaths(ev(dt))).toBeNull();
    }
    expect(readTool(ev(fakeDT().dt))).toBeNull();
    expect(TOOL_MIME).toBeTruthy();
  });
});
