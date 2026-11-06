import { describe, expect, it } from "vitest";
import type { PostIssue, PostSlideSource } from "@/lib/api";
import {
  DEFAULT_LIMITS,
  altSummary,
  checksSummary,
  editWindowClosed,
  formatSummary,
  framingSummary,
  sourcesSummary,
  aspectFor,
  blankSlide,
  captionStats,
  countChars,
  countHashtags,
  countMentions,
  indexAtY,
  isPending,
  issuesBySlide,
  PENDING_PROJECT,
  reorder,
  roomLeft,
  sanitizeState,
  slidesFromSources,
  truncateCaption,
  worstLevel,
  type PostDoc,
} from "./logic";

describe("reorder", () => {
  it("moves an item to a new index", () => {
    expect(reorder(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorder(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });
  it("clamps and ignores bad indexes", () => {
    expect(reorder(["a", "b"], 0, 9)).toEqual(["b", "a"]);
    expect(reorder(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});

describe("indexAtY", () => {
  it("picks the nearest tile centre", () => {
    expect(indexAtY([50, 150, 250], 10)).toBe(0);
    expect(indexAtY([50, 150, 250], 190)).toBe(1);
    expect(indexAtY([50, 150, 250], 900)).toBe(2);
  });
});

describe("caption counters (same patterns as the Go checks)", () => {
  it("counts runes, not UTF-16 units", () => {
    expect(countChars("a😀b")).toBe(3);
  });
  it("counts hashtags including non-Latin ones", () => {
    expect(countHashtags("#one #два text #three_3 # nope")).toBe(3);
  });
  it("counts @mentions but not e-mail addresses", () => {
    expect(countMentions("hi @alice and @bob.smith, mail me@example.com")).toBe(2);
    expect(countMentions("@first")).toBe(1);
  });
  it("reports characters left", () => {
    const st = captionStats("x".repeat(2300), DEFAULT_LIMITS);
    expect(st.left).toBe(-100);
    expect(captionStats("", DEFAULT_LIMITS).left).toBe(2200);
  });
});

describe("truncateCaption", () => {
  it("cuts long captions", () => {
    const t = truncateCaption("a".repeat(300));
    expect(t.truncated).toBe(true);
    expect(t.text.length).toBe(125);
    expect(truncateCaption("short").truncated).toBe(false);
  });
});

describe("slides from sources", () => {
  const src = (p: Partial<PostSlideSource>): PostSlideSource => ({ path: "/x", kind: "photo", width: 1, height: 1, durationMs: 0, hasGps: false, heic: false, error: "", ...p });
  it("keeps photos and clips, trims clips to the limit and skips the rest", () => {
    const r = slidesFromSources(
      [src({ path: "/a.jpg" }), src({ path: "/b.mp4", kind: "clip", durationMs: 90_000 }), src({ path: "/c.txt", kind: "other" }), src({ path: "/d.jpg", error: "gone" })],
      "carousel",
      DEFAULT_LIMITS,
    );
    expect(r.slides.map((s) => s.path)).toEqual(["/a.jpg", "/b.mp4"]);
    expect(r.slides[1]!.outMs).toBe(60_000);
    expect(r.skipped).toBe(2);
    const reel = slidesFromSources([src({ path: "/b.mp4", kind: "clip", durationMs: 200_000 })], "reel", DEFAULT_LIMITS);
    expect(reel.slides[0]!.outMs).toBe(180_000);
  });
});

describe("post shape helpers", () => {
  const doc = (n: number, format = "carousel"): PostDoc => ({ version: 1, format, aspect: "4:5", slides: Array.from({ length: n }, () => blankSlide("photo")), caption: "", keepLocation: false, folder: "", subfolders: false, extra: [], hidden: [] });
  it("tracks room left", () => {
    expect(roomLeft(doc(18), DEFAULT_LIMITS)).toBe(2);
    expect(roomLeft(doc(20), DEFAULT_LIMITS)).toBe(0);
    expect(roomLeft(doc(0, "reel"), DEFAULT_LIMITS)).toBe(1);
    expect(roomLeft(doc(1, "reel"), DEFAULT_LIMITS)).toBe(0);
  });
  it("keeps a carousel shape and forces 9:16 elsewhere", () => {
    expect(aspectFor("reel", "1:1")).toBe("9:16");
    expect(aspectFor("carousel", "9:16")).toBe("4:5");
    expect(aspectFor("carousel", "1:1")).toBe("1:1");
  });
  it("knows pending project slides", () => {
    expect(isPending(blankSlide("composition", { projectId: PENDING_PROJECT }))).toBe(true);
    expect(isPending(blankSlide("video", { projectId: "p1" }))).toBe(false);
    expect(isPending(blankSlide("photo"))).toBe(false);
  });
  it("makes unique slide ids", () => {
    expect(new Set(Array.from({ length: 50 }, () => blankSlide("photo").id)).size).toBe(50);
  });
});

describe("issues", () => {
  const issues: PostIssue[] = [
    { level: "warning", slideId: "a", message: "soft" },
    { level: "error", slideId: "a", message: "missing" },
    { level: "note", slideId: "", message: "post wide" },
  ];
  it("groups by slide and picks the worst level", () => {
    const m = issuesBySlide(issues);
    expect([...m.keys()]).toEqual(["a"]);
    expect(worstLevel(m.get("a") ?? [])).toBe("error");
    expect(worstLevel([])).toBe("");
  });
});

describe("saved state", () => {
  it("sanitises", () => {
    expect(sanitizeState({ lastPostId: "p", exports: { p: "/out", q: 3 } })).toEqual({ lastPostId: "p", exports: { p: "/out" } });
    expect(sanitizeState("junk")).toEqual({ lastPostId: "", exports: {} });
  });
});

describe("click-in summaries", () => {
  it("summarises format, sources, checks, alt text and framing", () => {
    expect(formatSummary({ format: "carousel", aspect: "1:1" })).toBe("Carousel · 1:1");
    expect(formatSummary({ format: "reel", aspect: "4:5" })).toBe("Reel · 9:16");
    expect(sourcesSummary({ folder: "", extra: [] })).toBe("No folder");
    expect(sourcesSummary({ folder: "C:\\Photos\\Trip\\", extra: ["a", "b"] })).toBe("Trip + 2 files");
    expect(sourcesSummary({ folder: "", extra: ["a"] })).toBe("1 file");
    const issue = (level: string) => ({ level, message: "x", slideId: "" }) as PostIssue;
    expect(checksSummary([])).toBe("All clear");
    expect(checksSummary([issue("warning"), issue("error")])).toBe("1 to fix");
    expect(checksSummary([issue("note")])).toBe("1 note");
    const slide = blankSlide("photo", { path: "a.jpg", altText: "A dog" });
    expect(altSummary(undefined, -1)).toBe("Select a slide");
    expect(altSummary(slide, 1)).toBe("Slide 2 · written");
    expect(altSummary({ ...slide, altText: " " }, 0)).toBe("Slide 1 · empty");
    expect(framingSummary(slide)).toBe("Fills the frame");
    expect(framingSummary({ ...slide, zoom: 1.5, rotation: 90 })).toBe("1.50× · 90°");
  });
});

describe("editing windows", () => {
  it("notices when Photo Composer or the Sequence Editor window closes", () => {
    expect(editWindowClosed(["tool:photo-composer"], [])).toBe(true);
    expect(editWindowClosed(["tool:video-editor", "tool:chat"], ["tool:chat"])).toBe(true);
    expect(editWindowClosed(["tool:photo-composer"], ["tool:photo-composer"])).toBe(false);
    expect(editWindowClosed(["tool:chat"], [])).toBe(false);
    expect(editWindowClosed([], ["tool:photo-composer"])).toBe(false);
  });
});
