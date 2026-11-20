// 10 Video Editor II: a green-screen clip keyed with the eyedropper over a rainy-street photo (matte view, then composite),
// and an explosion on a third track with the Screen blend mode.
import { newVideo, at, clipRects, rowY, chooseOption, addFromLibrary } from "./_d2a.mjs";

export default {
  id: "video-editor-2",
  title: "Video Editor II",
  tool: "Video Editor",
  kind: "a",
  roles: ["photo.rain", "video.green.snoop", "video.green.explosion"],
  async run(t) {
    // --- untimed setup: the rainy street (four 3 s stills back to back = 12 s), two more video tracks, both clips in Sources.
    const rain = t.role("photo.rain");
    await newVideo(t, [rain, rain, rain, rain]);
    await t.click({ css: "button", text: "Fit", exact: true });
    for (let i = 0; i < 2; i++) {
      await t.click({ css: "button", text: "Add", exact: true });
      await t.click({ css: '[role="menuitem"]', text: "Video track" });
      await t.hold(400);
    }
    await t.click({ css: "button", text: "Media", exact: true });
    await t.hold(500);
    await addFromLibrary(t, "video.green.snoop");
    await addFromLibrary(t, "video.green.explosion");
    await t.hold(800);
    t.markJobs();

    await t.rec.start();
    t.note("Snoop on a green screen goes onto the middle track; the chroma key's eyedropper picks the green; the matte view shows what is kept.", "Pick the green with the eyedropper, check the matte, and he is standing in the rain.");
    const yMid = await rowY(t, 1);
    await t.drag({ css: '[aria-label="Snoop Dog Dancing.mp4"]' }, await at(t, 420, yMid));
    await t.hold(600);
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(400);
    let clips = await clipRects(t);
    const snoop = clips.find((c) => c.row === 1);
    await t.click(await at(t, snoop.left + Math.min(snoop.w * 0.3, 120), snoop.y));
    await t.hold(700);
    await t.click({ css: "button", text: "Effects", exact: true });
    await t.click({ css: "button", text: "Add effect", exact: true });
    await t.type(null, "chroma");
    await t.key("Enter", { chip: false });
    await t.hold(700);
    await t.click({ css: "button", text: "Pick", exact: true });
    await t.hold(400);
    await t.click(await at(t, 680, 110));
    await t.hold(1500);

    // the matte view, then back to the composite
    t.note("Matte view: white is kept, black is gone.");
    await t.click({ css: "button", text: "Effects", exact: true });
    await t.hold(600);
    if (!(await t.exists({ css: 'select[aria-label="View"]' }))) await t.click({ text: "Chroma key", exact: true, nth: 0 });
    await t.hold(500);
    await chooseOption(t, "View", 1, "matte");
    await t.hold(2200);
    await chooseOption(t, "View", -1, "composite");
    await t.hold(1500);

    // the explosion: top track, Screen blend
    t.note("The explosion on the top track: the Screen blend mode lets the dark fall away.", "Screen blend turns the black around the explosion into nothing.");
    await t.click({ css: "button", text: "Close", exact: true });
    await t.click({ css: "button", text: "Media", exact: true });
    await t.hold(500);
    const yTop = await rowY(t, 0);
    await t.drag({ css: '[aria-label="Shitty Explosion.mp4"]' }, await at(t, 420, yTop));
    await t.hold(600);
    await t.click({ css: "button", text: "Close", exact: true });
    clips = await clipRects(t);
    const boom = clips.find((c) => c.row === 0);
    await t.click(await at(t, boom.left + Math.min(boom.w * 0.3, 120), boom.y));
    await t.hold(700);
    // its own green goes first (key it), then Screen lets the fire glow over the picture
    await t.click({ css: "button", text: "Effects", exact: true });
    await t.click({ css: "button", text: "Add effect", exact: true });
    await t.type(null, "chroma");
    await t.key("Enter", { chip: false });
    await t.hold(600);
    await t.click({ css: "button", text: "Pick", exact: true });
    await t.hold(400);
    await t.click(await at(t, 680, 110));
    await t.hold(1000);
    await t.click({ css: "button", text: "Transform", exact: true });
    await t.hold(600);
    await chooseOption(t, "Blend", 2, "screen");
    await t.hold(1200);
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(400);
    await t.click(await at(t, 420, 620)); // the ruler: playhead to the start
    await t.hold(400);
    await t.click({ css: "button", text: "Play", exact: true });
    await t.hold(4500);
    await t.key("Space", { chip: false });
    await t.hold(600);
    await t.still("Video Editor II");
    await t.rec.stop();
  },
};
