// 16 Text to Speech: an article paragraph becomes a voice.
import { ARTICLE_PARAGRAPH, openTool, paste, setValue, scrubPaths } from "./_d2b.mjs";

export default {
  id: "tts",
  title: "Text to Speech",
  tool: "Text to Speech",
  kind: "a",
  roles: [],
  async run(t) {
    await openTool(t, "tts", "Text to Speech"); // before filming: the Library behind it lists files that must not be on screen
    await scrubPaths(t);
    await t.rec.start();

    t.note("Paste a paragraph, pick a voice, and read it aloud.", "Paste any text, choose a voice, and Toolbox reads it to you, all on your computer.");
    await t.hover({ css: "select" }, 600);
    await setValue(t, "select", "am_michael");
    await t.hold(500);
    await paste(t, "textarea", ARTICLE_PARAGRAPH);
    await t.hold(900);

    await t.click({ text: "Read text aloud", css: "button" });
    await t.waitJob({ compress: true });
    await t.hold(1200);
    await t.hover({ css: "ul li" }, 1200);

    await t.still("Text to Speech");
    await t.rec.stop();
  },
};
