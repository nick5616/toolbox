import { describe, expect, it } from "vitest";
import { contrastRatio, formatHex, formatHsl, formatOklch, formatRgb, parseColor, rgbToOklch, wcag } from "./color.logic";
import { diffLines, diffStats, sideBySide, splitLines, unifiedText, type DiffOp } from "./diff.logic";
import { clampWidth, formatBigInt, groupBits, parseBigInt, twosComplement } from "./numbers.logic";
import { checkFlags, runRegex, segments } from "./regex.logic";
import { convertCase, countText, lineOp, slugify, splitWords } from "./text.logic";
import { formatInZone, guessUnit, parseTimeInput, relativeTime, toUnix, zoneList } from "./time.logic";

const NO: { ignoreWhitespace: boolean; ignoreCase: boolean } = { ignoreWhitespace: false, ignoreCase: false };

describe("time", () => {
  it("guesses units", () => {
    expect(guessUnit(1_700_000_000)).toBe("s");
    expect(guessUnit(1_700_000_000_000)).toBe("ms");
    expect(guessUnit(1_700_000_000_000_000)).toBe("us");
  });
  it("converts in every direction", () => {
    const r = parseTimeInput("1700000000");
    expect(r.ok && r.date.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    const u = toUnix(new Date("2023-11-14T22:13:20.000Z"));
    expect(u).toEqual({ s: "1700000000", ms: "1700000000000", us: "1700000000000000" });
    const iso = parseTimeInput("2023-11-14T22:13:20Z");
    expect(iso.ok && iso.unit).toBe("iso");
    const us = parseTimeInput("1700000000000000", "us");
    expect(us.ok && us.date.getTime()).toBe(1_700_000_000_000);
    expect(parseTimeInput("garbage").ok).toBe(false);
    expect(parseTimeInput("").ok).toBe(false);
  });
  it("formats in a zone and relative", () => {
    const d = new Date("2023-11-14T22:13:20Z");
    expect(formatInZone(d, "UTC")).toMatch(/^2023-11-14 22:13:20 UTC$/);
    expect(formatInZone(d, "Asia/Tokyo")).toContain("2023-11-15 07:13:20");
    expect(formatInZone(d, "Nope/Zone")).toBe("Unknown time zone");
    const now = d.getTime();
    expect(relativeTime(new Date(now + 3 * 3600_000), now)).toBe("in 3 hours");
    expect(relativeTime(new Date(now - 2 * 86400_000), now)).toBe("2 days ago");
    expect(relativeTime(d, now)).toBe("now");
    expect(zoneList()).toContain("UTC");
  });
});

describe("numbers", () => {
  it("parses and formats", () => {
    expect(parseBigInt("0xFF", 16)).toBe(255n);
    expect(parseBigInt("ff", 16)).toBe(255n);
    expect(parseBigInt("-1010", 2)).toBe(-10n);
    expect(parseBigInt("1_000", 10)).toBe(1000n);
    expect(parseBigInt("12345678901234567890123", 10)).toBe(12345678901234567890123n);
    expect(parseBigInt("9", 8)).toBeNull();
    expect(parseBigInt("", 10)).toBeNull();
    expect(parseBigInt("1.5", 10)).toBeNull();
    expect(formatBigInt(255n, 16)).toBe("FF");
    expect(formatBigInt(-8n, 2)).toBe("-1000");
  });
  it("shows two's complement", () => {
    const t = twosComplement(-1n, 8);
    expect(t).toMatchObject({ fits: true, unsigned: 255n, signed: -1n, bits: "11111111", hex: "FF" });
    expect(twosComplement(200n, 8)).toMatchObject({ fits: true, unsigned: 200n, signed: -56n });
    expect(twosComplement(256n, 8).fits).toBe(false);
    expect(twosComplement(-129n, 8).fits).toBe(false);
    expect(twosComplement(-1n, 64).hex).toBe("FFFFFFFFFFFFFFFF");
    expect(clampWidth(2)).toBe(8);
    expect(clampWidth(100)).toBe(64);
    expect(groupBits("10101010")).toBe("1010 1010");
  });
});

describe("colour", () => {
  it("parses formats", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("336699")).toEqual({ r: 51, g: 102, b: 153, a: 1 });
    expect(parseColor("#33669980")?.a).toBeCloseTo(0.5, 2);
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("rgb(10 20 30 / 50%)")?.a).toBe(0.5);
    expect(parseColor("rgba(10,20,30,0.25)")?.a).toBe(0.25);
    const hsl = parseColor("hsl(120, 100%, 50%)");
    expect(hsl && formatHex(hsl)).toBe("#00ff00");
    expect(parseColor("not a colour")).toBeNull();
  });
  it("formats", () => {
    const c = parseColor("#336699")!;
    expect(formatHex(c)).toBe("#336699");
    expect(formatRgb(c)).toBe("rgb(51 102 153)");
    expect(formatHsl(c)).toBe("hsl(210 50% 40%)");
    expect(formatOklch(parseColor("#ffffff")!)).toBe("oklch(100% 0 0)");
  });
  it("round-trips oklch", () => {
    const o = rgbToOklch(parseColor("#ff0000")!);
    expect(o.l).toBeCloseTo(0.628, 2);
    expect(o.c).toBeCloseTo(0.2577, 3);
    expect(o.h).toBeCloseTo(29.23, 1);
    const back = parseColor("oklch(62.8% 0.2577 29.23)")!;
    expect(Math.round(back.r)).toBe(255);
    expect(back.g).toBeLessThan(3);
  });
  it("computes WCAG contrast", () => {
    const black = parseColor("#000")!;
    const white = parseColor("#fff")!;
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    expect(contrastRatio(parseColor("#777")!, white)).toBeCloseTo(4.48, 1);
    expect(wcag(4.48)).toEqual({ aaNormal: false, aaLarge: true, aaaNormal: false, aaaLarge: false });
    expect(wcag(7.1)).toEqual({ aaNormal: true, aaLarge: true, aaaNormal: true, aaaLarge: true });
  });
});

describe("regex", () => {
  it("finds matches with groups", () => {
    const r = runRegex("(?<k>\\w+)=(\\d+)", "g", "a=1, b=22", null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.map((m) => m.text)).toEqual(["a=1", "b=22"]);
    expect(r.matches[1]?.groups).toEqual(["b", "22"]);
    expect(r.matches[1]?.named).toEqual({ k: "b" });
    expect(segments("a=1, b=22", r.matches).map((s) => s.text)).toEqual(["a=1", ", ", "b=22"]);
  });
  it("without g finds one match, with a replace preview", () => {
    const r = runRegex("a", "i", "aAa", "x");
    expect(r.ok && r.matches).toHaveLength(1);
    expect(r.ok && r.replaced).toBe("xAa");
    const g = runRegex("(\\w)(\\d)", "g", "a1 b2", "$2$1");
    expect(g.ok && g.replaced).toBe("1a 2b");
  });
  it("survives empty matches and caps results", () => {
    const e = runRegex("x*", "g", "ab", null);
    expect(e.ok && e.matches).toHaveLength(3);
    const big = runRegex("a", "g", "a".repeat(5000), null);
    expect(big.ok && big.truncated).toBe(true);
    expect(big.ok && big.matches).toHaveLength(1000);
  });
  it("reports errors", () => {
    expect(runRegex("(", "", "x", null).ok).toBe(false);
    expect(runRegex("a", "gg", "x", null)).toEqual({ ok: false, message: 'Flag "g" is repeated' });
    expect(checkFlags("q")).toMatch(/Unknown/);
    expect(runRegex("", "g", "abc", null)).toMatchObject({ ok: true, matches: [] });
  });
});

describe("diff", () => {
  const kinds = (ops: DiffOp[]) => ops.map((o) => (o.kind === "eq" ? " " : o.kind === "add" ? "+" : "-") + o.text);
  it("diffs lines", () => {
    expect(kinds(diffLines("a\nb\nc", "a\nx\nc", NO))).toEqual([" a", "-b", "+x", " c"]);
    expect(kinds(diffLines("", "a\nb", NO))).toEqual(["+a", "+b"]);
    expect(kinds(diffLines("a\nb", "", NO))).toEqual(["-a", "-b"]);
    expect(kinds(diffLines("a\nb", "a\nb", NO))).toEqual([" a", " b"]);
    expect(kinds(diffLines("a\nb\nc\nd\ne", "b\nc\nX\nd\ne\nf", NO))).toEqual(["-a", " b", " c", "+X", " d", " e", "+f"]);
  });
  it("matches a brute-force LCS length on random inputs", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0; t < 60; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 12) }, () => "abc"[Math.floor(rnd() * 3)]!);
      const b = Array.from({ length: Math.floor(rnd() * 12) }, () => "abc"[Math.floor(rnd() * 3)]!);
      const ops = diffLines(a.join("\n"), b.join("\n"), NO);
      const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      const lcs = dp[a.length]![b.length]!;
      const st = diffStats(ops);
      expect(st.removed).toBe(a.length - lcs);
      expect(st.added).toBe(b.length - lcs);
      expect(ops.filter((o) => o.kind !== "add").map((o) => o.text)).toEqual(a);
      expect(ops.filter((o) => o.kind !== "del").map((o) => o.text)).toEqual(b);
    }
  });
  it("ignores whitespace and case", () => {
    expect(diffStats(diffLines("a  b\nC", "a b\nc", { ignoreWhitespace: true, ignoreCase: true }))).toEqual({ added: 0, removed: 0 });
    expect(diffStats(diffLines("a  b", "a b", NO))).toEqual({ added: 1, removed: 1 });
  });
  it("pairs side-by-side rows and renders unified text", () => {
    const ops = diffLines("a\nb\nc", "a\nx\ny\nc", NO);
    const rows = sideBySide(ops);
    expect(rows.map((r) => [r.left?.text, r.right?.text])).toEqual([
      ["a", "a"],
      ["b", "x"],
      [undefined, "y"],
      ["c", "c"],
    ]);
    expect(unifiedText(ops, 1)).toBe(" a\n-b\n+x\n+y\n c");
    const long = diffLines("1\n2\n3\n4\n5\n6\n7\n8\n9", "1\n2\n3\n4\n5\n6\n7\n8\nX", NO);
    expect(unifiedText(long, 1)).toBe(" 8\n-9\n+X");
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
  });
  it("handles large, very different inputs without blowing up", () => {
    const a = Array.from({ length: 6000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 6000 }, (_, i) => `b${i}`).join("\n");
    const st = diffStats(diffLines(a, b, NO));
    expect(st).toEqual({ added: 6000, removed: 6000 });
  });
});

describe("text", () => {
  it("splits words", () => {
    expect(splitWords("fooBar_baz-qux XMLHttpRequest v2Beta")).toEqual(["foo", "Bar", "baz", "qux", "XML", "Http", "Request", "v", "2", "Beta"]);
  });
  it.each([
    ["camel", "helloWorldFooBar"],
    ["pascal", "HelloWorldFooBar"],
    ["snake", "hello_world_foo_bar"],
    ["kebab", "hello-world-foo-bar"],
    ["constant", "HELLO_WORLD_FOO_BAR"],
    ["title", "Hello World Foo Bar"],
    ["lower", "hello world-foo_bar"],
    ["upper", "HELLO WORLD-FOO_BAR"],
  ] as const)("converts to %s", (kind, want) => {
    expect(convertCase("Hello World-foo_bar", kind)).toBe(want);
  });
  it("slugifies", () => {
    expect(slugify("  Crème Brûlée -- Recipe!  ")).toBe("creme-brulee-recipe");
    expect(slugify("!!!")).toBe("");
  });
  it("counts", () => {
    expect(countText("")).toEqual({ chars: 0, words: 0, lines: 0, bytes: 0 });
    expect(countText("héllo wörld\nx 😀")).toEqual({ chars: 15, words: 4, lines: 2, bytes: 20 });
  });
  it("applies line operations", () => {
    expect(lineOp("b\na\nc\na", "sort-asc")).toBe("a\na\nb\nc");
    expect(lineOp("a2\na10\na1", "sort-asc")).toBe("a1\na2\na10");
    expect(lineOp("b\na\nc", "sort-desc")).toBe("c\nb\na");
    expect(lineOp("a\nb\na\nb\nc", "dedupe")).toBe("a\nb\nc");
    expect(lineOp("  a \n\tb", "trim")).toBe("a\nb");
    expect(lineOp("a\n\n  \nb", "remove-empty")).toBe("a\nb");
    expect(lineOp("a\nb", "reverse")).toBe("b\na");
  });
});
