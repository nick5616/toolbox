// 17 Local Chat: read the article PDF with OCR (text output), then ask Local Chat about it.
import { chatAsk, openTool, scrubPaths } from "./_d2b.mjs";

export default {
  id: "chat",
  title: "Local Chat",
  tool: "Local Chat",
  kind: "a",
  roles: ["doc.pdf"],
  async run(t) {
    await openTool(t, "ocr", "OCR");
    await scrubPaths(t);
    await t.rec.start();

    t.note("The article PDF goes in as text, then Local Chat answers questions about it.", "Hand a document to the local chat model and ask it anything. It never leaves your computer.");
    await t.handOff("ocr", "doc.pdf");
    await t.click({ css: "button", text: "Advanced" });
    await t.click({ css: '[role="switch"]' });
    await t.click({ css: "button, [role=radio]", text: "Text", exact: true, nth: 0 });
    await t.key("Escape", { chip: false });
    await t.hold(400);
    await t.click({ css: "button", textRe: "^Read text from" });
    await t.waitJob({ compress: true });
    await t.hold(600);

    await t.click({ css: "button", text: "Ask Local Chat" });
    await t.hold(800);
    await chatAsk(t, "Which beat is the backbone of dance music, and why?");
    await t.hold(1200);

    await t.still("Local Chat");
    await t.rec.stop();
  },
};
