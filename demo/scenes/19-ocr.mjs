// 19 OCR: the drum chart and a code-editor screenshot become text; copy one.
import { pick, withClipboardRestored } from "./_d2b.mjs";

export default {
  id: "ocr",
  title: "OCR",
  tool: "OCR",
  kind: "a",
  roles: ["image.drumchart", "image.screens"],
  async run(t) {
    await t.open("ocr");
    await t.rec.start();

    t.note("Two images in, their text out: a drum chart and a screenshot of code.", "Drop a scan or a screenshot and Toolbox reads the text in it.");
    await t.handOff("ocr", "image.drumchart", pick(t, "image.screens", "151455"));
    await t.hold(1000);
    await t.click({ css: "button", textRe: "^Read text from" });
    await t.waitJob({ compress: true });
    await t.hold(1500);

    t.note("Copy the text, or save it as a file.", "Copy it, or save it as a document.");
    await t.hover({ css: '[aria-label="Copy text"]', nth: 0 }, 600);
    await withClipboardRestored(async () => {
      await t.click({ css: '[aria-label="Copy text"]', nth: 0 });
      await t.hold(900);
    });
    await t.hold(800);
    await t.still("OCR");
    await t.rec.stop();
  },
};
