// 26 GIF & Contact Sheet: a clip becomes a GIF, then a contact sheet.
import { openTool, scrubPaths } from "./_d2b.mjs";

const MAKE = { css: "button", textRe: "^Make a (GIF|WebP|sheet)" };

export default {
  id: "gif",
  title: "GIF & Contact Sheet",
  tool: "GIF & Contact Sheet",
  kind: "a",
  roles: ["video.green.snoop"],
  async run(t) {
    await openTool(t, "gif", "GIF & Contact Sheet");
    await scrubPaths(t);
    await t.waitFor({ css: "button", text: "Add files…" });
    await t.rec.start();

    t.note("A short clip becomes a looping GIF.", "Turn a few seconds of any video into a GIF.");
    await t.handOff("gif", "video.green.snoop");
    await t.waitFor({ css: "button", text: "GIF", exact: true });
    await t.hold(1200);
    await t.click(MAKE);
    await t.waitJob({ compress: true });
    await t.hold(1500);

    t.note("The same clip as a contact sheet of frames with timecodes.", "Or a contact sheet: a grid of frames with their timecodes.");
    await t.click({ css: "button", text: "Contact sheet", exact: true });
    await t.hold(900);
    await t.click(MAKE);
    await t.waitJob({ compress: true });
    await t.hold(2000);

    await t.still("GIF and Contact Sheet");
    await t.rec.stop();
  },
};
