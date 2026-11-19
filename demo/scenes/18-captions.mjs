// 18 Caption Writer: six photos get alt text, a caption and hashtags; the text is written into copies.
import { openTool, scrubPaths } from "./_d2b.mjs";

export default {
  id: "captions",
  title: "Caption Writer",
  tool: "Caption Writer",
  kind: "a",
  roles: ["photo.park", "photo.facade", "photo.painting", "photo.dessert", "photo.flowers", "photo.ferris"],
  async run(t) {
    await openTool(t, "captions", "Caption Writer");
    await scrubPaths(t);
    await t.rec.start();

    t.note("Six photos in; alt text, a caption and hashtags out, written by the local model.", "Drop your photos and the local model writes alt text, captions and hashtags. Nothing is uploaded.");
    await t.handOff("captions", "photo.park", "photo.facade", "photo.painting", "photo.dessert", "photo.flowers", "photo.ferris");
    await t.hold(1000);
    await t.click({ css: "button", textRe: "^Write captions for" });
    await t.waitJob({ compress: true, timeoutMs: 30 * 60000 });
    await t.hold(1400);
    await t.scroll(null, 520, 1200);
    await t.hold(900);
    await t.scroll(null, -520, 1000);

    t.note("Write the text into copies of the photos; the originals are never touched.", "Write it into copies of the photos, so the text travels with them.");
    await t.click({ css: "button", text: "Write into copies…" });
    await t.hold(1200);
    await t.click({ css: '[role="dialog"] button', text: "Write copies" });
    await t.waitJob({ compress: true, allowFail: false, appearMs: 30000 });
    await t.hold(1600);

    await t.still("Caption Writer");
    await t.rec.stop();
  },
};
