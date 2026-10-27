import { describe, expect, it } from "vitest";
import { MAX_URLS, parseUrls, urlsError, validUrls } from "./urls";

describe("parseUrls", () => {
  it("splits on whitespace and validates", () => {
    const p = parseUrls("https://ok.com/x\nftp://x.com/a  not\thttps:///nohost http:foo");
    expect(p.map((x) => x.valid)).toEqual([true, false, false, false, false]);
    expect(p[0]).toMatchObject({ host: "ok.com", path: "/x" });
    expect(p[1]?.error).toBeTruthy();
  });
  it("accepts http and https only, case-insensitive scheme", () => {
    expect(parseUrls("HTTP://Example.com/a")[0]?.valid).toBe(true);
    expect(parseUrls("https://www.youtube.com/watch?v=abc")[0]).toMatchObject({ host: "youtube.com", path: "/watch?v=abc" });
  });
  it("collapses duplicates with count", () => {
    const p = parseUrls("https://a.com/x https://b.com https://a.com/x");
    expect(p).toHaveLength(2);
    expect(p[0]?.count).toBe(2);
    expect(validUrls(p)).toEqual(["https://a.com/x", "https://b.com"]);
  });
  it("empty text gives nothing", () => expect(parseUrls("  \n ")).toEqual([]));
  it("enforces max", () => {
    const text = Array.from({ length: MAX_URLS + 1 }, (_, i) => `https://a.com/${i}`).join(" ");
    expect(urlsError(parseUrls(text))).toMatch(/At most 50/);
    expect(urlsError(parseUrls("https://a.com"))).toBeUndefined();
  });
});
