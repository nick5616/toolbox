import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ exportText: vi.fn(), flush: vi.fn(), toast: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, EditStudioService: { ExportText: (...a: unknown[]) => h.exportText(...a) } };
});
vi.mock("../useEditAutosave", () => ({ flushEdit: () => h.flush() }));
vi.mock("@/components", async (orig) => {
  const actual = await orig<typeof import("@/components")>();
  return { ...actual, toast: (...a: unknown[]) => h.toast(...a) };
});

import { normalizeProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { DEFAULT_TEXT_STYLE, serializeTextStyle } from "@/viz/edit/schema";
import { useEditStudio } from "../store";
import { exportSrt } from "./exportSrt";

function open(captions: boolean, lines = "", start = 4000, end = 12_000) {
  const doc = normalizeProject(fixtureProject());
  const song = doc.song!;
  useEditStudio.getState().open("p1", "My Edit", {
    ...doc,
    song: { ...song, startMs: start, endMs: end },
    captions: captions ? { style: serializeTextStyle(DEFAULT_TEXT_STYLE), behindSubject: false, lines } : null,
  });
  useEditStudio.getState().setAnalysis(null, buildEditFixture(), "ready");
}

describe("exportSrt", () => {
  beforeEach(() => {
    h.exportText.mockReset().mockResolvedValue({});
    h.flush.mockReset().mockResolvedValue(undefined);
    h.toast.mockReset();
  });

  it("explains when there are no captions", async () => {
    open(false);
    await exportSrt();
    expect(h.exportText).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "warn" }));
  });

  it("sends the analysis lines inside the range in timeline ms", async () => {
    open(true);
    await exportSrt();
    expect(h.flush).toHaveBeenCalled();
    expect(h.exportText).toHaveBeenCalledTimes(1);
    const [id, req] = h.exportText.mock.calls[0] as [string, { kind: string; name: string; markers: unknown[]; cues: Array<{ startMs: number; endMs: number; text: string }> }];
    expect(id).toBe("p1");
    expect(req.kind).toBe("srt");
    expect(req.name).toBe("My Edit");
    expect(req.markers).toEqual([]);
    expect(req.cues.length).toBeGreaterThan(0);
    for (const c of req.cues) {
      expect(c.startMs).toBeGreaterThanOrEqual(0);
      expect(c.endMs).toBeLessThanOrEqual(8000);
      expect(c.text).not.toBe("");
    }
    // the fixture's first line starts at song 4 s = timeline 0
    expect(req.cues[0]?.startMs).toBe(0);
  });

  it("uses the edited lines", async () => {
    open(true, JSON.stringify([{ startMs: 5000, endMs: 6000, text: "mine", words: [] }, { startMs: 50_000, endMs: 51_000, text: "outside", words: [] }]));
    await exportSrt();
    const req = h.exportText.mock.calls[0]?.[1] as { cues: Array<{ startMs: number; endMs: number; text: string }> };
    expect(req.cues).toEqual([{ startMs: 1000, endMs: 2000, text: "mine", words: [] }]);
  });

  it("explains when no line is in range", async () => {
    open(true, "[]");
    await exportSrt();
    expect(h.exportText).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "warn" }));
  });
});
