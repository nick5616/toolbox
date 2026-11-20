import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, teaserWindow, titleOf, wrap } from "../cuts.mjs";

test("wrap breaks on spaces within the width", () => {
  assert.deepEqual(wrap("Split any song into stems in one click.", 16), ["Split any song", "into stems in", "one click."]);
  assert.deepEqual(wrap("", 10), []);
});

test("teaserWindow takes the 10 s before the end handle", () => {
  assert.deepEqual(teaserWindow(32.3), { start: 21.3, length: 10 });
  assert.deepEqual(teaserWindow(8), { start: 0, length: 8 });
});

test("titleOf drops the scene number", () => {
  assert.equal(titleOf({ file: "A-roll/09 Video Editor I.mp4" }), "Video Editor I");
  assert.equal(titleOf({ file: "A-roll/26 GIF & Contact Sheet.mp4" }), "GIF & Contact Sheet");
});

test("parseArgs", () => {
  const o = parseArgs(["--only", "shorts,gifs", "--force"]);
  assert.ok(o.force && o.only.has("shorts") && o.only.has("gifs") && !o.only.has("sizzle"));
  assert.throws(() => parseArgs(["--nope"]));
});
