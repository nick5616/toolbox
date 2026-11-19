import { describe, expect, it } from "vitest";
import { OutputKind } from "@/lib/api";
import { EMPTY_STATUS, hitKey, mergeHits, normalizeHit } from "@/state/search";
import { hit, img, out, status } from "./testFixtures";
import { formatMoment, highlightParts, hitToItem, posBadge, sourceIcons, splitSnippet, statusLine, strengthInfo, textBlock } from "./searchHits";
import { completions, chunkPrefix, visibleLabels } from "./DetailSearch";
import { groupThings } from "./ThingsView";

describe("splitSnippet", () => {
  it("bolds the text between the markers", () => {
    expect(splitSnippet("…total \u000244 71\u0003 due 30 Nov…")).toEqual([
      { text: "…total ", bold: false },
      { text: "44 71", bold: true },
      { text: " due 30 Nov…", bold: false },
    ]);
  });

  it("keeps markup the file contained as plain text", () => {
    const evil = `<img src=x onerror=alert(1)> \u0002<b>bold</b>\u0003 <script>x()</script>`;
    const parts = splitSnippet(evil);
    expect(parts.map((p) => p.text).join("")).toBe(`<img src=x onerror=alert(1)> <b>bold</b> <script>x()</script>`);
    expect(parts.filter((p) => p.bold).map((p) => p.text)).toEqual(["<b>bold</b>"]);
  });

  it("drops stray and unbalanced markers", () => {
    expect(splitSnippet("a\u0003b\u0002c")).toEqual([
      { text: "a", bold: false },
      { text: "b", bold: false },
      { text: "c", bold: true },
    ]);
    expect(splitSnippet("")).toEqual([]);
  });
});

describe("highlightParts", () => {
  it("marks every search word, case-insensitively, as text", () => {
    expect(highlightParts("Total 4471 due; TOTAL again", "total 4471")).toEqual([
      { text: "Total", bold: true },
      { text: " ", bold: false },
      { text: "4471", bold: true },
      { text: " due; ", bold: false },
      { text: "TOTAL", bold: true },
      { text: " again", bold: false },
    ]);
  });
  it("returns the text untouched for an empty query", () => {
    expect(highlightParts("hello", "")).toEqual([{ text: "hello", bold: false }]);
    expect(highlightParts("", "x")).toEqual([{ text: "", bold: false }]);
  });
});

describe("strength, sources and badges", () => {
  it("strong/good/maybe get a dot with the % in the tip; label and name hits have none", () => {
    expect(strengthInfo({ strength: "strong", score: 0.412 })).toMatchObject({ level: "strong", label: "Strong", tip: "Strong match (41%)" });
    expect(strengthInfo({ strength: "good", score: 0.15 }).level).toBe("good");
    expect(strengthInfo({ strength: "maybe", score: 0.03 }).tip).toContain("3%");
    expect(strengthInfo({ strength: "label", score: 1 }).level).toBe("");
    expect(strengthInfo({ strength: "name", score: 0 }).level).toBe("");
  });

  it("maps where the text was found to an icon, once each", () => {
    expect(sourceIcons(["concept"])).toEqual([]);
    expect(sourceIcons(["ocr"]).map((s) => s.icon)).toEqual(["scan-text"]);
    expect(sourceIcons(["pdf", "doc"]).map((s) => s.icon)).toEqual(["file-text"]);
    expect(sourceIcons(["speech", "ocr"]).map((s) => s.icon)).toEqual(["mic", "scan-text"]);
  });

  it("formats moments and 0-based pages", () => {
    expect(formatMoment(42_000)).toBe("0:42");
    expect(formatMoment(3_725_000)).toBe("1:02:05");
    expect(posBadge("video", "mp4", 42_000)?.text).toBe("0:42");
    expect(posBadge("audio", "mp3", 0)?.text).toBe("0:00");
    expect(posBadge("document", "pdf", 2)?.text).toBe("p. 3");
    expect(posBadge("document", "pptx", 0)?.text).toBe("slide 1");
    expect(posBadge("image", "png", -1)).toBeNull();
    expect(posBadge("image", "png", 5)).toBeNull();
  });
});

describe("hitToItem", () => {
  it("wraps an output hit and keeps the hit info", () => {
    const o = img("a");
    const item = hitToItem(normalizeHit(hit(o, { strength: "good", score: 0.2, snippet: "x" })), []);
    expect(item.key).toBe("a");
    expect(item.outputId).toBe("a");
    expect(item.hit?.strength).toBe("good");
  });

  it("makes an unregistered file a path item and a project its own key, named from Places", () => {
    const plain = hitToItem(normalizeHit(hit(null, { path: "/lib/Received/x.png" })), []);
    expect(plain.key).toBe("path:/lib/Received/x.png");
    expect(plain.registered).toBe(false);
    const proj = hitToItem(normalizeHit(hit(null, { source: "project", projectId: "p9", path: "/support/projects/p9/thumb.jpg" })), [{ id: "p9", name: "Sunset", moduleId: "paint", updatedAt: 5 } as never]);
    expect(proj.key).toBe("project:p9");
    expect(proj.name).toBe("Sunset");
    expect(proj.moduleId).toBe("paint");
    expect(proj.hit?.projectId).toBe("p9");
  });
});

describe("mergeHits", () => {
  const A = normalizeHit(hit(img("a"), { strength: "strong" }));
  const B = normalizeHit(hit(img("b"), { strength: "good" }));
  const N = normalizeHit(hit(img("n"), { strength: "name", score: 0, via: ["name"] }));
  const C = normalizeHit(hit(img("c"), { strength: "strong" }));

  it("takes the newer answer: concept hits arrive above the name-only ones", () => {
    const merged = mergeHits([N], [C, A, N]);
    expect(merged.map(hitKey)).toEqual(["c", "a", "n"]);
  });

  it("keeps the selected hit when the new answer no longer lists it, at the end of its tier", () => {
    const merged = mergeHits([A, B, N], [C, N], "b");
    expect(merged.map(hitKey)).toEqual(["c", "b", "n"]);
  });

  it("is just the new answer without a held key", () => {
    expect(mergeHits([A], [B]).map(hitKey)).toEqual(["b"]);
  });
});

describe("statusLine (every state of SPEC §1.1)", () => {
  it("not installed / off", () => {
    expect(statusLine(EMPTY_STATUS).tone).toBe("off");
    expect(statusLine(status({ enabled: false })).text).toBe("Indexing is off");
  });
  it("indexing pictures and reading text", () => {
    expect(statusLine(status({ stage: "pictures", pending: 1860, done: 1240, total: 3100 })).text).toBe("Indexing pictures 1,240 of 3,100");
    expect(statusLine(status({ stage: "text", pending: 220, done: 80, total: 300 })).text).toBe("Reading text 80 of 300");
  });
  it("transcribing names the file", () => {
    const l = statusLine(status({ stage: "speech", speechPending: 12, speechDone: 2, current: "/lib/meeting.mp4" }));
    expect(l.text).toBe("Transcribing 2 of 14 (meeting.mp4)");
    expect(l.tone).toBe("busy");
  });
  it("paused offers Resume; waiting says why", () => {
    expect(statusLine(status({ paused: true }))).toMatchObject({ text: "Paused", action: "resume" });
    expect(statusLine(status({ waiting: true })).text).toBe("Waiting for your jobs to finish");
  });
  it("failures and up to date", () => {
    expect(statusLine(status({ failed: 3 }))).toMatchObject({ text: "3 files couldn't be indexed", action: "failures" });
    expect(statusLine(status({ failed: 1 })).text).toBe("1 file couldn't be indexed");
    expect(statusLine(status({ total: 3100 })).text).toBe("Up to date · 3,100 files");
  });
});

describe("detail helpers", () => {
  it("visibleLabels: yours first, then the strongest 8 auto labels, hidden never", () => {
    const labels = [
      { label: "hid", display: "hid", source: "hidden", score: 0.9, pos: -1 },
      { label: "mine", display: "mine", source: "user", score: 1, pos: -1 },
      ...Array.from({ length: 10 }, (_, i) => ({ label: `l${i}`, display: `l${i}`, source: "auto", score: i / 10, pos: -1 })),
    ];
    const v = visibleLabels(labels);
    expect(v).toHaveLength(9);
    expect(v[0]?.label).toBe("mine");
    expect(v[1]?.label).toBe("l9");
    expect(v.some((l) => l.label === "hid")).toBe(false);
  });

  it("completions: matches by display, not already on the file, yours first", () => {
    const things = [
      { label: "apple", display: "apple", category: "food", count: 5, user: false, cover: "" },
      { label: "pineapple", display: "pineapple", category: "food", count: 9, user: false, cover: "" },
      { label: "apple pie", display: "apple pie", category: "food", count: 2, user: true, cover: "" },
    ];
    const have = [{ label: "apple", display: "apple", source: "auto", score: 0.5, pos: -1 }];
    expect(completions("app", things, have).map((c) => c.label)).toEqual(["apple pie", "pineapple"]);
    expect(completions("", things, have)).toEqual([]);
  });

  it("chunkPrefix says [m:ss] for speech, p. N for pages", () => {
    expect(chunkPrefix({ source: "speech", pos: 61_000, endPos: 70_000, text: "" }, "video", "mp4")).toBe("[1:01]");
    expect(chunkPrefix({ source: "pdf", pos: 2, endPos: -1, text: "" }, "pdf", "pdf")).toBe("p. 3");
    expect(chunkPrefix({ source: "ocr", pos: -1, endPos: -1, text: "" }, "image", "png")).toBe("");
    expect(textBlock([{ source: "speech", pos: 0, endPos: 5, text: "hi" }], true)).toBe("[0:00] hi");
  });
});

describe("groupThings", () => {
  it("orders Your labels first, then the eight categories, dropping empty ones", () => {
    const l = (label: string, category: string, count = 3, user = false) => ({ label, display: label, category, count, user, cover: "" });
    const g = groupThings([l("car", "vehicles"), l("dog", "animals"), l("mine", "", 3, true), l("odd", "mystery"), l("page", "documents")]);
    expect(g.map((s) => s.title)).toEqual(["Your labels", "Animals", "Things", "Vehicles", "Documents & screens"]);
    expect(g.find((s) => s.title === "Things")?.labels.map((x) => x.label)).toEqual(["odd"]);
  });
});

describe("kinds", () => {
  it("fixtures are what the tests think they are", () => {
    expect(out("x").kind).toBe(OutputKind.KindAudio);
  });
});
