import { describe, expect, it } from "vitest";
import { base64ToBytes, decodeText, encodeText, mimeForPath, reshapeBase64, toDataUrl } from "./base64.logic";
import { matchingAlgo, normalizeDigest, parseHashResult } from "./hash.logic";
import { caretExcerpt, findJsonError, formatJson, jsonToYaml, minifyJson, parseJson, parseYaml, sortKeys } from "./json.logic";
import { claimStatus, decodeJwt } from "./jwt.logic";
import { buildUrl, decodeComponent, encodeComponent, parseUrl } from "./url.logic";
import { clampCount, generateIds, ulid, uuidV4, uuidV7, type IdDeps } from "./uuid.logic";

describe("json", () => {
  it("formats, minifies and sorts", () => {
    const v = parseJson('{"b":1,"a":{"d":2,"c":[3,{"z":1,"y":2}]}}');
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(minifyJson(v.value)).toBe('{"b":1,"a":{"d":2,"c":[3,{"z":1,"y":2}]}}');
    expect(formatJson({ a: 1 }, "2")).toBe('{\n  "a": 1\n}');
    expect(formatJson({ a: 1 }, "4")).toBe('{\n    "a": 1\n}');
    expect(formatJson({ a: 1 }, "tab")).toBe('{\n\t"a": 1\n}');
    expect(minifyJson(sortKeys(v.value))).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  });

  it.each([
    ['{"a":1,}', 1, 8],
    ['{\n  "a": 1\n  "b": 2\n}', 3, 3],
    ['{"a": tru}', 1, 7],
    ['[1, 2', 1, 6],
    ['{"a":"x', 1, 6],
    ["{'a':1}", 1, 2],
    ["", 1, 1],
    ["1 2", 1, 3],
  ])("locates the error in %j at %i:%i", (text, line, col) => {
    const e = findJsonError(text);
    expect(e).not.toBeNull();
    expect([e?.line, e?.col]).toEqual([line, col]);
  });

  it("accepts valid documents and agrees with JSON.parse", () => {
    for (const t of ["0", "-1.5e+3", '"a\\u00e9"', "[]", "{}", " null ", '{"a":[1,2,{"b":null}]}']) expect(findJsonError(t)).toBeNull();
  });

  it("draws a caret", () => {
    const text = '{"a":1,}';
    const e = findJsonError(text)!;
    expect(caretExcerpt(text, e)).toBe('{"a":1,}\n       ^');
  });

  it("converts to and from YAML", () => {
    const y = jsonToYaml({ a: 1, b: ["x", { c: true }] });
    expect(y).toBe("a: 1\nb:\n  - x\n  - c: true\n");
    const back = parseYaml(y);
    expect(back).toEqual({ ok: true, value: { a: 1, b: ["x", { c: true }] } });
    expect(parseYaml("a: [1, 2").ok).toBe(false);
  });
});

describe("base64", () => {
  it("encodes UTF-8 with toggles", () => {
    expect(encodeText("héllo ✓", { urlSafe: false, padding: true })).toBe("aMOpbGxvIOKckw==");
    expect(encodeText("héllo ✓", { urlSafe: false, padding: false })).toBe("aMOpbGxvIOKckw");
    expect(encodeText("??>>", { urlSafe: false, padding: true })).toBe("Pz8+Pg==");
    expect(encodeText("??>>", { urlSafe: true, padding: false })).toBe("Pz8-Pg");
  });
  it("decodes both alphabets, with or without padding", () => {
    expect(decodeText("aMOpbGxvIOKckw==")).toBe("héllo ✓");
    expect(decodeText("aMOpbGxv IOKckw")).toBe("héllo ✓");
    expect(decodeText("Pz8-Pg")).toBe("??>>");
  });
  it("rejects bad input", () => {
    expect(() => decodeText("a$b")).toThrow();
    expect(() => decodeText("abcde")).toThrow();
    expect(() => decodeText("/w==")).toThrow(/UTF-8/);
    expect([...base64ToBytes("/w==")]).toEqual([255]);
  });
  it("reshapes, guesses mime and builds data URLs", () => {
    expect(reshapeBase64("a+b/c==", { urlSafe: true, padding: false })).toBe("a-b_c");
    expect(mimeForPath("C:\\x\\Pic.PNG")).toBe("image/png");
    expect(mimeForPath("noext")).toBe("application/octet-stream");
    expect(toDataUrl("QQ==", "text/plain")).toBe("data:text/plain;base64,QQ==");
  });
});

describe("url", () => {
  it("encodes and decodes components", () => {
    expect(encodeComponent("a b&c/é")).toBe("a%20b%26c%2F%C3%A9");
    expect(decodeComponent("a%20b%26")).toEqual({ ok: true, value: "a b&" });
    expect(decodeComponent("%E0%A4%A").ok).toBe(false);
  });
  it("parses and rebuilds", () => {
    const r = parseUrl("https://user:pw@example.com:8080/a/b?x=1&y=a%20b&x=2#frag");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parts.hostname).toBe("example.com");
    expect(r.parts.port).toBe("8080");
    expect(r.parts.params).toEqual([
      { key: "x", value: "1" },
      { key: "y", value: "a b" },
      { key: "x", value: "2" },
    ]);
    expect(buildUrl(r.parts)).toBe("https://user:pw@example.com:8080/a/b?x=1&y=a%20b&x=2#frag");
    r.parts.params.push({ key: "q", value: "é&" });
    expect(buildUrl(r.parts)).toContain("&q=%C3%A9%26");
  });
  it("rejects relative URLs", () => {
    expect(parseUrl("/a/b").ok).toBe(false);
    expect(parseUrl("  ").ok).toBe(false);
  });
});

describe("hash helpers", () => {
  it("normalises and matches digests", () => {
    expect(normalizeDigest("  SHA256:ABCDEF12 34\n")).toBe("abcdef1234");
    expect(normalizeDigest("AB:CD:EF:12")).toBe("abcdef12");
    expect(matchingAlgo({ md5: "aa", sha256: "abcdef12" }, "ABCDEF12")).toBe("sha256");
    expect(matchingAlgo({ md5: "aa" }, "")).toBeNull();
    expect(matchingAlgo({ md5: "aa" }, "bb")).toBeNull();
  });
  it("parses job results", () => {
    expect(parseHashResult('{"files":[{"path":"/a","size":3,"hashes":{"md5":"x"}}]}')).toEqual([{ path: "/a", size: 3, hashes: { md5: "x" } }]);
    expect(parseHashResult("nope")).toBeNull();
    expect(parseHashResult(undefined)).toBeNull();
  });
});

describe("ids", () => {
  const fixed: IdDeps = { now: () => 0x017f21cfd130, random: (n) => new Uint8Array(n).fill(0xff) };
  it("sets version and variant bits", () => {
    expect(uuidV4(fixed)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(uuidV7(fixed)).toBe("017f21cf-d130-7fff-bfff-ffffffffffff");
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidV7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("builds ULIDs", () => {
    expect(ulid({ now: () => 1469918176385, random: (n) => new Uint8Array(n) })).toBe("01ARYZ6S410000000000000000");
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("clamps counts and cases output", () => {
    expect(clampCount(0)).toBe(1);
    expect(clampCount(5000)).toBe(1000);
    expect(clampCount(NaN)).toBe(1);
    expect(generateIds("v4", 2000, true)).toHaveLength(1000);
    expect(generateIds("v4", 3, true).every((s) => s === s.toUpperCase())).toBe(true);
    expect(generateIds("ulid", 3, false).every((s) => s === s.toLowerCase())).toBe(true);
    expect(new Set(generateIds("v7", 50, false)).size).toBe(50);
  });
});

describe("jwt", () => {
  // header {"alg":"HS256","typ":"JWT"}, payload {"sub":"1","iat":1000,"exp":2000,"nbf":1500}
  const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const token = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "1", iat: 1000, exp: 2000, nbf: 1500 })}.sig`;
  it("decodes and flags times", () => {
    const d = decodeJwt(`Bearer ${token}`, 1_800_000);
    expect(d.headerText).toContain('"alg": "HS256"');
    expect(d.signature).toBe("sig");
    expect(d.claims.map((c) => [c.name, c.status])).toEqual([
      ["iat", "ok"],
      ["nbf", "ok"],
      ["exp", "ok"],
    ]);
    expect(decodeJwt(token, 2_500_000).claims.find((c) => c.name === "exp")?.status).toBe("expired");
    expect(decodeJwt(token, 1_200_000).claims.find((c) => c.name === "nbf")?.status).toBe("not-yet-valid");
    expect(claimStatus("iat", 1, 0)).toBe("ok");
  });
  it("rejects malformed tokens", () => {
    expect(() => decodeJwt("a.b", 0)).toThrow(/three/);
    expect(() => decodeJwt("!!.e30.x", 0)).toThrow(/header/);
    expect(() => decodeJwt(`${btoa("nope")}.e30.x`, 0)).toThrow(/JSON/);
  });
});
