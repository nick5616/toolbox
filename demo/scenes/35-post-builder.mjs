// 35 Post Builder: a carousel from Library photos, the caption written with Caption Writer, the checks, export.
export default {
  id: "post-builder",
  title: "Post Builder",
  tool: "Post Builder",
  kind: "a",
  roles: ["photo.ferris", "photo.flowers", "photo.dessert"],
  async run(t) {
    await t.rec.start();
    t.note(
      "A three-slide carousel from Library photos; the caption is written inside the post by Caption Writer, then the checks against Instagram's rules and an export folder.",
      "Build a post slide by slide, let the local model draft the caption, and export a folder ready to upload."
    );
    await t.open("post-builder");
    if (await t.exists({ css: "button", text: "New post" })) await t.click({ css: "button", text: "New post" });
    await t.hold(1200);
    await t.click({ css: "button", text: "Add", exact: true });
    await t.click({ text: "From Library" });
    const dlg = '[role="dialog"]';
    await t.waitFor({ within: dlg, text: "IMG_4227" });
    await t.hold(700);
    await t.click({ within: dlg, text: "IMG_4227" });
    await t.click({ within: dlg, text: "IMG_4160" });
    await t.click({ within: dlg, text: "IMG_4127" });
    await t.hold(500);
    await t.click({ within: dlg, css: "button", textRe: "^Add" });
    await t.hold(2200);
    await t.click({ text: "Caption" });
    await t.hold(600);
    await t.click({ text: "Write with Caption Writer" });
    await t.hold(2500);
    await t.click({ css: 'textarea[placeholder^="Lisbon"]' });
    await t.type(null, "A weekend in the city: a ferris wheel at night, a flower ceiling, brunch.");
    await t.hold(600);
    await t.click({ css: "button", textRe: "^Write captions for 3 files" });
    await t.waitJob({ compress: true, timeoutMs: 15 * 60000 });
    await t.hold(1500);
    await t.click({ css: "button", text: "Use caption", exact: true });
    await t.hold(1500);
    await t.click({ css: '[aria-label="Close"], button[aria-label*="lose"]' });
    await t.hold(1800);
    await t.still("Post Builder caption");
    await t.rec.stop();
    await t.reset();
  },
};
