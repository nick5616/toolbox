// 25 Scene Splitter: the B-roll reel is cut back into its shots.
import { makeReel, openTool, scrubPaths } from "./_d2b.mjs";

export default {
  id: "scenes",
  title: "Scene Splitter",
  tool: "Scene Splitter",
  kind: "a",
  roles: ["video.broll"],
  async run(t) {
    const reel = makeReel(t); // untimed: the six clips joined into one reel
    await openTool(t, "scenes", "Scene Splitter");
    await scrubPaths(t);
    await t.waitFor({ css: "button", text: "Add files…" });
    await t.rec.start();

    t.note("One long video in; every shot comes out as its own clip and still.", "Drop a long video and Toolbox finds where the shots change and cuts them apart.");
    await t.handOff("scenes", reel);
    await t.hold(1400);
    await t.click({ css: "button", textRe: "^Split \\d+ video" });
    await t.waitJob({ compress: true, timeoutMs: 20 * 60000 });
    await t.hold(2200);

    await t.still("Scene Splitter");
    await t.rec.stop();
  },
};
