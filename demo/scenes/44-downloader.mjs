// 44 Downloader: the public-domain Wikimedia video from roles.json -> a video in the Library. The only network use besides Web Archiver.
import fs from "node:fs";

const url = JSON.parse(fs.readFileSync(new URL("../roles.json", import.meta.url), "utf8")).links.video.page;

export default {
  id: "downloader",
  title: "Downloader",
  tool: "Downloader",
  kind: "a",
  roles: [],
  async run(t) {
    await t.rec.start();
    t.note(
      "A link to a public-domain Wikimedia Commons video pasted in, Audio mode (MP3), Download; the file lands in the Library.",
      "Paste a link, pick video or audio, and it is saved straight into your Library."
    );
    await t.open("downloader");
    // Video mode remuxes to MP4, which fails for this WebM (Vorbis audio cannot go into MP4: an app bug, reported):
    // the scene downloads the soundtrack in the default Audio mode instead.
    await t.click({ css: "button", text: "Audio", exact: true });
    await t.hold(500);
    await t.type('textarea, input[placeholder^="Paste"]', url);
    await t.hold(2200);
    await t.click({ css: "button", textRe: "^Download [0-9]" });
    await t.waitJob({ compress: true, timeoutMs: 10 * 60000 });
    await t.hold(1800);
    await t.still("Downloader");
    await t.rec.stop();
    await t.reset();
  },
};
