// 24 Trimmer: set a cut on the filmstrip, see where the fast (keyframe) cut would really start, switch to precise, export.
import { openTool, scrubPaths } from "./_d2b.mjs";

export default {
  id: "trimmer",
  title: "Trimmer",
  tool: "Video Trimmer",
  kind: "a",
  roles: ["video.broll"],
  async run(t) {
    const clip = t.roles("video.broll").find((p) => p.includes("Skyline"));
    await openTool(t, "trimmer", "Video Trimmer");
    await scrubPaths(t);
    await t.rec.start();

    t.note("Drag the ends of the cut on the filmstrip.", "Drop a video, then drag the ends of the cut on the filmstrip.");
    await t.handOff("trimmer", clip);
    await t.waitFor({ css: '[aria-label="Start of 1"]' });
    await t.hold(1200);
    await t.drag({ css: '[aria-label="Start of 1"]' }, { text: "0:03", exact: true });
    await t.drag({ css: '[aria-label="End of 1"]' }, { text: "0:09", exact: true });
    await t.hold(600);

    t.note("The fast mode says where the cut will really start: on the keyframe before it.", "The fast mode tells you where the cut will really start: on the keyframe before it.");
    await t.hover({ text: "earlier (keyframe)" }, 1800);

    t.note("Precise mode cuts exactly where you put the handles.", "Switch to precise and it cuts exactly where you put the handles.");
    await t.click({ css: "button", text: "Precise · re-encode" });
    await t.hold(1200);
    await t.click({ css: "button", textRe: "^Export" });
    await t.waitJob({ compress: true });
    await t.hold(1800);

    await t.still("Trimmer");
    await t.rec.stop();
  },
};
