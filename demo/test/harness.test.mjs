import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { clipFile, compressedNote, hashSeed, parseCombo, seeded, typingDelays } from "../capture/act.mjs";
import { descendants, isCaptureSupport, supportFromLog } from "../capture/app.mjs";
import { buildFfmpegArgs, concatList, joinedDuration, xfadeOffsets } from "../capture/record.mjs";
import { buildEntries, mergeEntries, renderMarkdown } from "../capture/shotlist.mjs";
import { expandRole, globMatch, roleStatus } from "../roles.mjs";

const cursor = createRequire(import.meta.url)("../capture/cursor.js");

test("concat durations come from frame timestamps", () => {
  const { text, duration } = concatList(
    [
      { file: "C:\\tmp\\a.jpg", ts: 10 },
      { file: "C:\\tmp\\b.jpg", ts: 10.5 },
      { file: "C:\\tmp\\c.jpg", ts: 12 },
    ],
    13,
  );
  assert.equal(duration, 3);
  assert.match(text, /file 'C:\/tmp\/a\.jpg'\nduration 0\.500000/);
  assert.match(text, /file 'C:\/tmp\/b\.jpg'\nduration 1\.500000/);
  assert.match(text, /file 'C:\/tmp\/c\.jpg'\nduration 1\.000000\nfile 'C:\/tmp\/c\.jpg'\n$/);
});

test("fast frames keep their short durations; the last lasts at least one output frame", () => {
  const { duration } = concatList([{ file: "a", ts: 1 }, { file: "b", ts: 1.016 }], 1.016);
  assert.ok(Math.abs(duration - (0.016 + 1 / 30)) < 1e-6);
});

test("xfade offsets and joined duration", () => {
  assert.deepEqual(xfadeOffsets([5, 4, 3], 0.4), [4.6, 8.2]);
  assert.ok(Math.abs(joinedDuration([5, 4, 3], 0.4) - 11.2) < 1e-9);
  const args = buildFfmpegArgs({ lists: ["a.txt", "b.txt"], durations: [5, 4], out: "o.mp4" });
  assert.ok(args.join(" ").includes("xfade=transition=fade:duration=0.400:offset=4.600"));
  assert.ok(args.includes("+faststart") && args.includes("16") && args.includes("slow"));
});

test("cursor moves take 350-700 ms by distance on a cubic ease", () => {
  assert.equal(cursor.moveDuration(0), 350);
  assert.equal(cursor.moveDuration(700), 525);
  assert.equal(cursor.moveDuration(5000), 700);
  assert.equal(cursor.ease(0), 0);
  assert.equal(cursor.ease(1), 1);
  assert.equal(cursor.ease(0.5), 0.5);
  assert.ok(cursor.ease(0.25) < 0.25);
  assert.deepEqual(cursor.pathPoint({ x: 0, y: 0 }, { x: 100, y: 50 }, 0.5), { x: 50, y: 25 });
});

test("typing runs at 12-18 cps and is repeatable", () => {
  const text = "x".repeat(200);
  const a = typingDelays(text, seeded(hashSeed("s")));
  const b = typingDelays(text, seeded(hashSeed("s")));
  assert.deepEqual(a, b);
  const cps = 200 / (a.reduce((s, d) => s + d, 0) / 1000);
  assert.ok(cps > 10 && cps < 21, `cps ${cps}`);
});

test("key combos", () => {
  const k = parseCombo("Mod+K", "win32");
  assert.equal(k.modifiers, 2);
  assert.equal(k.label, "Ctrl+K");
  assert.equal(k.vk, 75);
  assert.equal(parseCombo("Mod+K", "darwin").label, "Cmd+K");
  assert.equal(parseCombo("Shift+Tab").modifiers, 8);
  assert.equal(parseCombo("Enter").text, "\r");
  assert.throws(() => parseCombo("Hyper+K"));
});

const doc = {
  exclude: ["*.asd", "secret.png"],
  roles: {
    a: { files: ["a.mp3"] },
    b: { files: ["Extras/b.mp4"] },
    ab: { of: ["a", "b"] },
    pics: { glob: ["Shot *.png"] },
  },
};

test("roles resolve through of, files and globs, honouring excludes", () => {
  const listing = ["a.mp3", "Shot 1.png", "shot 2.PNG", "secret.png", "Shot 3.png.asd"];
  assert.deepEqual(expandRole(doc, "ab", listing), ["a.mp3", "Extras/b.mp4"]);
  assert.deepEqual(expandRole(doc, "pics", listing), ["Shot 1.png", "shot 2.PNG"]);
  assert.deepEqual(roleStatus(doc, "ab", listing).missing, ["Extras/b.mp4"]);
  assert.equal(roleStatus(doc, "a", listing).ok, true);
  assert.equal(globMatch("IMG_*.HEIC", "img_1.heic"), true);
  assert.throws(() => expandRole(doc, "nope", listing));
});

test("the shipped roles.json is consistent", async () => {
  const { loadRoles } = await import("../roles.mjs");
  const real = loadRoles(path.join(import.meta.dirname, "..", "roles.json"));
  for (const name of Object.keys(real.roles)) expandRole(real, name, []); // no cycles, no dangling names
  assert.ok(real.links.video.url.startsWith("https://upload.wikimedia.org/"));
});

test("shot list entries and markdown", () => {
  const results = [
    { scene: { number: 3, id: "stems", title: "Stems", tool: "Stem Splitter", kind: "a" }, clips: [{ file: "A-roll/03 Stems.mp4", duration: 21.34, compressed: "3:12 \u2192 0:01" }], stills: ["Stills/03 Stems.png"], notes: ["Four stems."], vo: ["Split any song."], assets: ["x.mp3"] },
  ];
  const entries = buildEntries(results);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].duration, 21.3);
  const md = renderMarkdown(entries);
  assert.match(md, /\| 03 \| A-roll\/03 Stems\.mp4 \| Stem Splitter \| 21\.3 s \| x\.mp3 \| Four stems\. \| Split any song\. \| 3:12 \u2192 0:01 \|/);
  const merged = mergeEntries([{ n: 3, scene: "stems", file: "old" }, { n: 1, scene: "lib", file: "l" }], entries, ["stems"]);
  assert.deepEqual(merged.map((e) => e.file), ["l", "A-roll/03 Stems.mp4", "Stills/03 Stems.png"]);
  assert.equal(compressedNote(192000), "3:12 \u2192 0:01");
  assert.equal(clipFile({ number: 3, title: "Stems", kind: "a" }), path.join("A-roll", "03 Stems.mp4"));
});

test("process tree walk finds only descendants", () => {
  const list = [
    { pid: 1, ppid: 0, name: "a" },
    { pid: 2, ppid: 1, name: "toolbox.exe" },
    { pid: 3, ppid: 2, name: "msedgewebview2.exe" },
    { pid: 4, ppid: 3, name: "msedgewebview2.exe" },
    { pid: 9, ppid: 1, name: "msedge.exe" },
  ];
  assert.deepEqual(descendants(list, 2).map((p) => p.pid), [3, 4]);
});

test("the app's support folder is read from its log and must be a capture dir", () => {
  const line = 'time=2026-11-19T13:21:14.602-08:00 level=INFO msg="starting Toolbox" version=0.1.0-dev support=C:\\Users\\me\\repo\\.dev\\demo-capture-support\n';
  const s = supportFromLog(line);
  assert.equal(s, "C:\\Users\\me\\repo\\.dev\\demo-capture-support");
  assert.equal(isCaptureSupport(s, ["C:\\Users\\me\\repo\\.dev\\demo-capture-support"]), true);
  assert.equal(isCaptureSupport("C:\\Users\\me\\AppData\\Roaming\\Toolbox", ["C:\\Users\\me\\repo\\.dev\\demo-capture-support"]), false);
});
