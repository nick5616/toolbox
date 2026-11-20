// 79 Transcribe and export: SRT and TXT are picked as the formats, the narration is transcribed, the transcript is
// read with its timestamps, and each file has its own Reveal / Open / Save a copy.
import { openTool, scrubPaths } from "./_d2b.mjs";

const chip = (name) => ({ css: '[aria-labelledby="transcribe-formats"] button', text: name, exact: true });

export default {
  id: "transcribe-export",
  title: "Transcribe and export",
  tool: "Transcribe",
  kind: "a",
  roles: ["video.talk"],
  async run(t) {
    await openTool(t, "transcribe", "Transcribe");
    await scrubPaths(t);
    await t.rec.start();

    t.note("Drop the narration, then choose which transcript files to save: SRT subtitles and plain TXT.", "Choose how you want the transcript: subtitles with timestamps, plain text, or both.");
    await t.handOff("transcribe", "video.talk");
    await t.hold(1200);
    for (const f of ["SRT", "TXT"]) {
      const on = await t.eval(`[...document.querySelectorAll('[aria-labelledby="transcribe-formats"] button')].some((b) => b.textContent.trim() === ${JSON.stringify(f)} && b.getAttribute("aria-pressed") === "true")`);
      if (!on) {
        await t.click(chip(f));
        await t.hold(500);
      }
    }
    await t.hold(800);
    await t.click({ css: "button", textRe: "^Transcribe \\d+ files?" });
    await t.move({ css: "main" });
    await t.waitJob({ compress: true });
    await t.hold(1500);

    t.note("The result: the language, the length, the number of timed segments, and one file per format.", "Each transcript comes as real files you can use anywhere.");
    await t.hover({ css: '[role="listitem"], li', text: ".srt" }, 1600).catch(() => {});
    await t.hold(1200);

    t.note("Preview reads the transcript with its timestamps.", "Read it with its timestamps right here.");
    await t.click({ css: "button", text: "Preview", exact: true });
    await t.hold(3200);
    await t.still("Transcribe export");

    t.note("Every file offers Show in folder, Open, and Save a copy; nothing is copied or moved until you ask.", "Show it in its folder, open it, or save a copy wherever you like.");
    await t.key("Escape", { chip: false });
    await t.hold(600);
    await t.hover({ css: 'button[aria-label^="Show in"], button[aria-label^="Reveal"]', nth: 0 }, 1500).catch(() => {});
    await t.hover({ css: 'button[aria-label="Open"]', nth: 0 }, 1500).catch(() => {});
    await t.hover({ css: 'button[aria-label="Save a copy…"]', nth: 0 }, 1800).catch(() => {});
    await t.rec.stop();
    await t.reset();
  },
};
