// 21 Document Converter: the article (Markdown) to PDF, then to Word.
import { setValue } from "./_d2b.mjs";

export default {
  id: "documents",
  title: "Document Converter",
  tool: "Document Converter",
  kind: "a",
  roles: ["doc.text"],
  async run(t) {
    await t.open("documents");
    await t.rec.start();

    t.note("A Markdown article becomes a PDF, then a Word document.", "Turn a Markdown file into a PDF or a Word document.");
    await t.handOff("documents", "doc.text");
    await t.hold(700);
    await t.hover({ css: "select" }, 500);
    await setValue(t, "select", "pdf");
    await t.hold(600);
    await t.click({ css: "button", textRe: "^Convert \\d+ document" });
    await t.waitJob({ compress: true });
    await t.hold(1000);

    await setValue(t, "select", "docx");
    await t.hold(600);
    await t.click({ css: "button", textRe: "^Convert \\d+ document" });
    await t.waitJob({ compress: true });
    await t.hold(1600);

    await t.still("Document Converter");
    await t.rec.stop();
  },
};
