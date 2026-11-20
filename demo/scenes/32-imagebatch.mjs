// 32 Image Batch: ten photos -> web-sized WebP with a text watermark.
export default {
  id: "imagebatch",
  title: "Image Batch",
  tool: "Image Batch",
  kind: "a",
  roles: ["photo.heic"],
  async run(t) {
    await t.rec.start();
    t.note(
      "Ten photos dropped on Image Batch: long side 1600 px, WebP, a text watermark; the preview shows the result before anything runs.",
      "Resize, convert and watermark a whole folder of photos in one go."
    );
    await t.open("imagebatch");
    await t.handOff("imagebatch", ...t.roles("photo.heic").slice(0, 10));
    await t.waitFor({ text: "Process 10 pictures" });
    await t.hold(800);
    await t.click({ css: "input", nth: 0 });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "1600");
    await t.hold(500);
    await t.click({ text: "Advanced" });
    await t.hold(500);
    await t.click({ within: '[role="dialog"], aside', css: "button", text: "WebP" });
    await t.hold(400);
    await t.click({ css: "button", text: "Text", exact: true });
    await t.hold(700);
    await t.type('input[placeholder*="Your name"]', "\u00a9 Demo Studio");
    await t.hold(1000);
    await t.click({ css: '[aria-label="Close"], button[aria-label*="lose"]' });
    await t.hold(800);
    await t.click({ css: "button", textRe: "^Process 10 pictures" });
    await t.waitJob({ compress: true });
    await t.hold(800);
    await t.scroll(null, 520, 900);
    await t.hold(1000);
    await t.still("Image Batch");
    await t.rec.stop();
    await t.reset();
  },
};
