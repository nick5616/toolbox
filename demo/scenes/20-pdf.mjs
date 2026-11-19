// 20 PDF Toolkit: merge two PDFs, move a page to the front, compress.
import fs from "node:fs";
import path from "node:path";
import { extrasDir, latestOutputs, scrubPaths, setValue } from "./_d2b.mjs";

const TAB = (name) => ({ css: "button", text: name, exact: true });

export default {
  id: "pdf",
  title: "PDF Toolkit",
  tool: "PDF Toolkit",
  kind: "a",
  roles: ["doc.pdf"],
  async run(t) {
    // Untimed setup: a second PDF (a short practice plan, made by the Document Converter).
    const dir = extrasDir(t, "doc.pdf");
    const md = path.join(dir, "Practice plan.md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      md,
      [
        "# Practice plan",
        "",
        "Ten minutes a day is enough.",
        "",
        "1. Warm up on a pad with the eighth-note rock beat.",
        "2. Add the kick variation, slowly.",
        "3. Finish with four on the floor at a steady tempo.",
        "",
        "Keep the metronome on and speed up only when it feels easy.",
        "",
      ].join("\n"),
    );
    await t.open("documents");
    await t.handOff("documents", md);
    await setValue(t, "select", "pdf");
    await t.click({ css: "button", textRe: "^Convert \\d+ document" });
    await t.waitJob({ moduleId: "documents" });
    const [second] = await latestOutputs(t, "documents");
    await t.open("pdf");
    await scrubPaths(t);

    await t.rec.start();
    t.note("Merge two PDFs into one.", "Combine PDFs in one click.");
    await t.handOff("pdf", "doc.pdf", second);
    await t.hold(900);
    await t.click({ css: "button", textRe: "^Merge \\d+ PDFs" });
    await t.waitJob({ moduleId: "pdf", compress: true });
    const [merged] = await latestOutputs(t, "pdf");
    await t.hold(1000);

    t.note("Open the merged file's pages and move the last page up front.", "Reorder, rotate or delete pages.");
    await t.click(TAB("Organize pages"));
    await t.handOff("pdf", merged);
    await t.waitFor({ css: '[role="option"][aria-label="Page 3"]' });
    await t.hold(1200);
    await t.click({ css: '[role="option"][aria-label="Page 3"]' });
    for (let i = 0; i < 2; i++) {
      await t.key("Alt+ArrowLeft");
      await t.hold(250);
    }
    await t.hold(700);
    await t.click({ css: "button", textRe: "^Save as new PDF" });
    await t.waitJob({ moduleId: "pdf", compress: true });
    const [organized] = await latestOutputs(t, "pdf");
    await t.hold(900);

    t.note("Compress it: text stays sharp, photos shrink.", "Then shrink it for sending.");
    await t.click(TAB("Compress PDF"));
    await t.handOff("pdf", organized);
    await t.hold(700);
    await t.click({ css: "button", textRe: "^Compress PDF", nth: 1 });
    await t.waitJob({ moduleId: "pdf", compress: true });
    await t.hold(1600);

    await t.still("PDF Toolkit");
    await t.rec.stop();
  },
};
