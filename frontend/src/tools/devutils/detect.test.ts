import { describe, expect, it } from "vitest";
import { detectUtil } from "./detect";

describe("detectUtil", () => {
  it.each([
    ['{"a":1}', "json", "input"],
    ["  [1, 2, 3]\n", "json", "input"],
    ['{"a": 1,}', "json", "input"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "jwt", "token"],
    ["https://example.com/a?b=1", "url", "url"],
    ["1700000000", "time", "text"],
    ["1700000000000", "time", "text"],
    ["#3366cc", "color", "text"],
    ["rgb(10, 20, 30)", "color", "text"],
    ["oklch(0.7 0.1 200)", "color", "text"],
    ["SGVsbG8sIHdvcmxkISBIZWxsbw==", "base64", "input"],
    ["12345678901234567890", "text", "text"],
    ["hello there", "text", "text"],
    ["", "text", "text"],
    ["a.b.c", "text", "text"],
  ])("%j -> %s", (text, util, key) => {
    expect(detectUtil(text)).toEqual({ util, key });
  });
});
