// 22 Converter: a WMV clip to MP4, then a song to MP3.
// The app's Converter does not list .wmv as an input yet, so the untimed setup remuxes the WMV (no re-encode)
// into an AVI container next to it; the conversion on camera is the real thing.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg, extrasDir, setValue } from "./_d2b.mjs";

export default {
  id: "converter",
  title: "Converter",
  tool: "Converter",
  kind: "a",
  roles: ["video.green.kill", "song.alt"],
  async run(t) {
    const dir = extrasDir(t, "video.green.kill");
    const clip = path.join(dir, "Round Winning Kill.avi");
    if (!fs.existsSync(clip)) {
      fs.mkdirSync(dir, { recursive: true });
      ffmpeg(["-i", t.role("video.green.kill"), "-c", "copy", clip]);
    }

    await t.open("converter");
    await t.rec.start();

    t.note("A video clip converted to MP4.", "Pick a preset, drop a file, and Toolbox converts it.");
    await t.handOff("converter", clip);
    await t.hover({ css: "select" }, 500);
    await setValue(t, "select", "mp4-h264");
    await t.hold(600);
    await t.click({ css: "button", textRe: "^Convert (files|\\d+ files?)" });
    await t.waitJob({ compress: true });
    await t.hold(1200);

    t.note("Then a song to MP3.", "Audio works the same way.");
    await t.click({ css: "button", text: "Clear" });
    await setValue(t, "select", "mp3-v0");
    await t.hold(500);
    await t.handOff("converter", "song.alt");
    await t.hold(400);
    await t.click({ css: "button", textRe: "^Convert (files|\\d+ files?)" });
    await t.waitJob({ compress: true });
    await t.hold(1500);

    await t.still("Converter");
    await t.rec.stop();
  },
};
