// 11 Video Editor III: audio. Detach a video's sound onto its own track, shape the volume line (a dip) and the fades, open the export dialog.
import { newVideo, at, clipRects, rowY } from "./_d2a.mjs";

export default {
  id: "video-editor-3",
  title: "Video Editor III",
  tool: "Video Editor",
  kind: "a",
  roles: ["video.talk"],
  async run(t) {
    // --- untimed setup: the narration video as a new edit, prepared.
    await newVideo(t, [t.role("video.talk")]);
    await t.hold(2000);
    await t.waitPrepared();
    await t.click({ css: "button", text: "Fit", exact: true });
    await t.hold(800);
    t.markJobs();

    await t.rec.start();
    t.note("Detach audio: the narration's sound becomes its own clip on an audio track, linked to the picture.", "Right-click, detach audio, and the sound is its own clip.");
    const y0 = await rowY(t, 0);
    await t.click(await at(t, 640, y0), { right: true });
    await t.hold(500);
    await t.click({ css: '[role="menu"] [role="menuitem"]', text: "Detach audio" });
    await t.hold(1200);

    t.note("The volume line: Ctrl+click adds keys, drag them down to dip the volume; the corner circles are the fades.", "Draw a volume dip right on the clip, and set the fades with the corner handles.");
    let clips = await clipRects(t);
    const voice = clips.find((c) => c.row === 1);
    if (!voice) throw new Error("no detached audio clip");
    await t.click(await at(t, voice.left + voice.w * 0.1, voice.top + 6)); // select it
    await t.hold(700);
    const zeroY = await t.eval(`(()=>{const l=document.querySelector('[data-gain-line] line');if(!l)return null;const r=l.getBoundingClientRect();return r.top+r.height/2})()`);
    if (zeroY === null) throw new Error("the volume line is not showing");
    const xs = [0.28, 0.32, 0.52, 0.56].map((f) => voice.left + voice.w * f);
    for (const x of xs) await t.click(await at(t, x, zeroY), { ctrl: true });
    await t.hold(500);
    const down = voice.top + voice.h * 0.78;
    await t.drag({ css: "[data-gain-line] circle", nth: 1 }, await at(t, xs[1], down));
    await t.drag({ css: "[data-gain-line] circle", nth: 2 }, await at(t, xs[2], down));
    await t.hold(900);
    await t.drag({ css: '[data-gain-line] circle[class*="fadeHandle"]', nth: 1 }, await at(t, voice.left + voice.w - 110, voice.top + 5));
    await t.drag({ css: '[data-gain-line] circle[class*="fadeHandle"]', nth: 0 }, await at(t, voice.left + 70, voice.top + 5));
    await t.hold(900);

    t.note("The export dialog: shape, quality, where it goes.", "When it sounds right, the export dialog has everything in one place.");
    await t.click({ css: "button", text: "Export", exact: true });
    await t.hold(2500);
    await t.still("Video Editor III");
    await t.hold(1500);
    await t.key("Escape", { chip: false });
    await t.hold(500);
    await t.rec.stop();
  },
};
