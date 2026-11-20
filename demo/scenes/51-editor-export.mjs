// 51 Video Editor: the export dialog. Size, frame rate, format, quality and audio are chosen, the export runs, and the
// finished file is listed with Reveal, Open and Save a copy. The export is the In-Out range (2 s to 8 s), set with I and O.
import { newVideo, chooseOption } from "./_d2a.mjs";
import { ensurePrepared } from "./_d4a.mjs";

export default {
  id: "editor-export",
  title: "Export dialog and result",
  tool: "Video Editor",
  kind: "a",
  roles: ["video.broll"],
  async run(t) {
    // --- untimed setup: one B-roll clip (12 s), prepared and fitted.
    const broll = t.roles("video.broll");
    await newVideo(t, [broll[0]]);
    await t.click({ css: "button", text: "Fit", exact: true });
    await ensurePrepared(t);
    await t.key("Home", { chip: false });
    t.markJobs();
    const seconds = async (n) => {
      for (let i = 0; i < n; i++) await t.key("Shift+ArrowRight", { chip: false });
    };

    await t.rec.start();
    t.note("In and Out points (I and O) mark the part to export: 2 s to 8 s.", "Mark In and Out to export just the part you want.");
    await seconds(2);
    await t.key("I");
    await t.hold(500);
    await seconds(6);
    await t.key("O");
    await t.hold(1200);
    t.note("Export opens the dialog: size, frame rate, format, quality, audio and range, with the length and an estimated file size.", "Everything about the file is in one dialog, with an estimate of how big it will be.");
    await t.click({ css: "button", text: "Export", exact: true });
    await t.waitFor({ css: '[role="dialog"] select[aria-label="Size"]' });
    await t.hold(1200);
    await chooseOption(t, "Size", -1, "720");
    await t.hold(500);
    await chooseOption(t, "Quality", -1, "draft");
    await t.hold(500);
    await chooseOption(t, "Audio", 1, "320");
    await t.hold(500);
    if (!/range/.test((await t.eval(`document.querySelector('[role="dialog"] select[aria-label="Range"]')?.value ?? ""`)) ?? "")) await chooseOption(t, "Range", 1, "In");
    await t.hold(500);
    await t.hold(1800);
    await t.still("Export dialog");

    t.note("Export renders the edit; the progress shows at the bottom of the window.", "Press Export; it renders the edit.");
    await t.click({ css: '[role="dialog"] button', text: "Export", exact: true });
    await t.move({ css: "main" });
    await t.waitJob({ compress: true, moduleId: "video-studio", timeoutMs: 20 * 60000 });
    await t.hold(1500);

    t.note("The finished file is named on screen with Reveal, Open and Save a copy beside it.", "When it is done the file is listed with Show in folder, Open and Save a copy.");
    await t.waitFor({ css: '[data-testid="last-export"]' });
    await t.hover({ css: '[data-testid="last-export"] [data-tip]', nth: 0 }, 1200); // the path on hover
    const buttons = await t.eval(`document.querySelectorAll('[data-testid="last-export"] button').length`);
    for (let i = 0; i < Math.min(buttons, 4); i++) await t.hover({ css: '[data-testid="last-export"] button', nth: i }, 900);
    await t.still("Export dialog and result");
    await t.rec.stop();
  },
};
