// 45 Web Archiver: the Wikipedia article from roles.json -> a single self-contained HTML file.
import fs from "node:fs";

const url = JSON.parse(fs.readFileSync(new URL("../roles.json", import.meta.url), "utf8")).links.article.url;

export default {
  id: "archiver",
  title: "Web Archiver",
  tool: "Web Archiver",
  kind: "a",
  roles: [],
  async run(t) {
    await t.rec.start();
    t.note(
      "The Wikipedia article on the drum kit pasted into Web Archiver; one click saves the whole page, images and styles included, as a single HTML file.",
      "Save any web page as one file you can keep and open offline."
    );
    await t.open("archiver");
    await t.type('textarea, input[type="text"], input:not([type])', url);
    await t.hold(2200);
    await t.click({ css: "button", textRe: "^Save page" });
    await t.waitJob({ compress: true, timeoutMs: 10 * 60000 });
    await t.hold(1800);
    await t.still("Web Archiver");
    await t.rec.stop();
    await t.reset();
  },
};
