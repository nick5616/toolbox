// 28 Upscale: the small rainbow frog image at 4x, with the before/after slider.
// The Upscaler does not take .gif inputs, so the untimed setup saves the GIF's first frame as a PNG next to it.
import fs from "node:fs";
import path from "node:path";
import { extrasDir, ffmpeg, openTool, scrubPaths } from "./_d2b.mjs";

export default {
  id: "upscale",
  title: "Upscale",
  tool: "Upscaler",
  kind: "a",
  roles: ["image.gif"],
  async run(t) {
    const png = path.join(extrasDir(t, "image.gif"), "rainbowfrog.png");
    if (!fs.existsSync(png)) {
      fs.mkdirSync(path.dirname(png), { recursive: true });
      ffmpeg(["-i", t.role("image.gif"), "-frames:v", "1", png]);
    }
    await openTool(t, "upscaler", "Upscaler");
    await scrubPaths(t);
    await t.waitFor({ css: "button", text: "Add files…" });
    await t.rec.start();

    t.note("A small image enlarged four times, without the blur.", "Enlarge a small image four times without the blur.");
    await t.handOff("upscaler", png);
    await t.hold(900);
    await t.click({ css: "button", text: "4×", exact: true });
    await t.hold(500);
    await t.click({ css: "button", textRe: "^Upscale \\d+ image" });
    await t.waitJob({ compress: true, timeoutMs: 20 * 60000 });
    await t.hold(1200);

    t.note("Slide between the original and the 4x result.", "Slide between before and after.");
    const compare = { css: '[aria-label^="Compare"]' };
    if (await t.exists(compare)) {
      await t.drag(compare, { text: "Original", exact: true });
      await t.hold(700);
      await t.drag(compare, { text: "Upscaled", exact: true }).catch(() => {});
      await t.hold(900);
    }
    await t.still("Upscale");
    await t.rec.stop();
  },
};
