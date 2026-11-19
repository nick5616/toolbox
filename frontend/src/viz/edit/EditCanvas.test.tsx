import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditFiles, EditInputs } from "./types";

const engines: Array<{ setEdit: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];

vi.mock("./engine", () => ({
  EditEngine: class {
    setEdit = vi.fn();
    render = vi.fn();
    dispose = vi.fn();
    setQuality = vi.fn();
    needs = () => [];
    samplePre = vi.fn(() => [0.1, 0.2, 0.3] as [number, number, number]);
    constructor() {
      engines.push(this);
    }
  },
}));
vi.mock("./compile", () => ({ compileEdit: vi.fn(() => ({ compiled: true, fps: 30 })) }));

import { EditFrameProvider } from "../frames/provider";
import { EditCanvas, getEditCanvasHandle } from "./EditCanvas";

const files = (url: string): EditFiles => ({ streams: { "v:a": { url, indexUrl: `${url}.idx` } }, images: {} });
const inputs = (f: EditFiles): EditInputs => ({ project: { fps: 30, seed: 1 }, files: f }) as unknown as EditInputs;

afterEach(() => {
  engines.length = 0;
  vi.restoreAllMocks();
});

describe("EditCanvas", () => {
  it("hands the compiled edit to the engine only when it changes, never per frame", () => {
    const inp = inputs(files("d"));
    const { rerender } = render(<EditCanvas inputs={inp} width={320} height={180} timeMs={0} playing={false} quality="draft" />);
    for (let i = 1; i <= 30; i++) rerender(<EditCanvas inputs={inp} width={320} height={180} timeMs={i * 33} playing={false} quality="draft" />);
    const e = engines[0];
    expect(e?.render.mock.calls.length).toBeGreaterThan(20);
    expect(e?.setEdit.mock.calls.length).toBeLessThanOrEqual(2); // mount + the compiled-edit effect, both the same object
    const objs = new Set(e?.setEdit.mock.calls.map((c) => c[0]));
    expect(objs.size).toBe(1);

    rerender(<EditCanvas inputs={inputs(files("d"))} width={320} height={180} timeMs={990} playing={false} quality="draft" />);
    const objs2 = new Set(e?.setEdit.mock.calls.map((c) => c[0]));
    expect(objs2.size).toBe(2); // a new compiled edit was passed on
  });

  it("Full plays the export-tier streams and shows the chip; Draft doesn't", () => {
    const spy = vi.spyOn(EditFrameProvider.prototype, "setFiles");
    const inp = inputs(files("draft"));
    const full = files("export");
    const { rerender, queryByText } = render(<EditCanvas inputs={inp} fullFiles={full} width={320} height={180} timeMs={0} playing={false} quality="draft" />);
    expect(queryByText("Full")).toBeNull();
    rerender(<EditCanvas inputs={inp} fullFiles={full} width={320} height={180} timeMs={0} playing={false} quality="full" />);
    expect(queryByText("Full")).not.toBeNull();
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0];
    expect(last?.streams["v:a"]?.url).toBe("export");
    rerender(<EditCanvas inputs={inp} fullFiles={full} width={320} height={180} timeMs={0} playing={false} quality="draft" />);
    expect(spy.mock.calls[spy.mock.calls.length - 1]?.[0].streams["v:a"]?.url).toBe("draft");
  });

  it("exposes samplePre while the engine is alive", () => {
    let handle: unknown = null;
    const { unmount } = render(<EditCanvas inputs={inputs(files("d"))} width={320} height={180} timeMs={0} playing={false} quality="draft" onHandle={(h) => (handle = h)} />);
    expect(getEditCanvasHandle()?.samplePre("c1", 0.5, 0.5)).toEqual([0.1, 0.2, 0.3]);
    expect(handle).not.toBeNull();
    unmount();
    expect(getEditCanvasHandle()).toBeNull();
    expect(handle).toBeNull();
  });
});
