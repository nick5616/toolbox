// 23 Compress to Size: a long B-roll reel (about 45 MB) squeezed under Discord's limit.
import { makeReel, openTool, scrubPaths } from "./_d2b.mjs";

export default {
  id: "compress",
  title: "Compress to Size",
  tool: "Compress to Size",
  kind: "a",
  roles: ["video.broll"],
  async run(t) {
    const reel = makeReel(t); // untimed: the six clips joined into one reel
    await openTool(t, "compress", "Compress to Size");
    await scrubPaths(t);
    await t.waitFor({ css: "button", text: "Add files…" });
    await t.rec.start();

    t.note("The reel is far over Discord's 20 MB; the preview says what will happen before anything runs.", "Pick where the file is going, and Toolbox shrinks it to fit.");
    await t.handOff("compress", reel);
    await t.waitFor({ text: "WHAT WOULD HAPPEN" }).catch(() => {});
    await t.hover({ css: "select" }, 1600);
    await t.hold(1200);
    await t.click({ css: "button", textRe: "^Compress \\d+ file" });
    await t.waitJob({ compress: true, timeoutMs: 20 * 60000 });
    await t.hold(2200);

    await t.still("Compress to Size");
    await t.rec.stop();
  },
};
