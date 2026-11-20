// 48 Video Editor: keyframes on the timeline. Scale and position keyed over a clip, a different ease on each key
// (a preset, then a hand-drawn curve), and the playback. Scene 09 shows a picture-in-picture move; this one is the
// keyframe tools themselves: the diamonds, jumping between keys, the ease picker and the curve editor.
import { newVideo, at, clipRects, chooseOption } from "./_d2a.mjs";
import { setSlider, playheadForward, ensurePrepared, pointOf } from "./_d4a.mjs";

export default {
  id: "editor-keyframes",
  title: "Keyframes and easing",
  tool: "Video Editor",
  kind: "a",
  roles: ["video.broll"],
  async run(t) {
    // --- untimed setup: the park B-roll (12 s) as a new edit, prepared.
    await newVideo(t, [t.roles("video.broll")[4]]);
    await t.click({ css: "button", text: "Fit", exact: true });
    await ensurePrepared(t);
    t.markJobs();

    await t.rec.start();
    t.note("Select the clip, open Transform: every parameter has a keyframe diamond.", "Every parameter can be animated: add a keyframe and change the value somewhere else in time.");
    const [clip] = await clipRects(t);
    if (!clip) throw new Error("no clip on the timeline");
    await t.click(await at(t, clip.left + clip.w * 0.5, clip.y));
    await t.key("Home", { chip: false }); // clicking a clip also moves the playhead: back to the start
    await t.hold(600);
    await t.click({ css: "button", text: "Transform", exact: true });
    await t.hold(800);

    t.note("A key at the start for Scale and Position x, then the playhead moves on 4 s (Shift+Right = 1 s) and new values become new keys.");
    await t.click({ css: 'button[aria-label="Add Scale key"]' });
    await t.click({ css: 'button[aria-label="Add Position x key"]' });
    await t.hold(600);
    await playheadForward(t, 4);
    await setSlider(t, "Scale", 0.305); // writes a key at the playhead
    await setSlider(t, "Position x", 0.53);
    await t.hold(700);
    await playheadForward(t, 4);
    await setSlider(t, "Scale", 0.25);
    await setSlider(t, "Position x", 0.47);
    await t.hold(900);

    t.note("The keys show on the clip; the arrows beside the diamond jump from key to key.", "The keys sit right on the clip, and the arrows jump between them.");
    await t.click({ css: 'button[aria-label="Previous Scale key"]' });
    await t.hold(700);
    await t.click({ css: 'button[aria-label="Previous Scale key"]' });
    await t.hold(900);

    t.note("The first key's ease: Ease in-out.", "Each key says how the value moves to the next one.");
    await chooseOption(t, "Easing of Scale key", -1, "ease in-out");
    await t.hold(900);

    t.note("The second key: Custom, with two handles to draw the curve.", "Or draw your own curve with two handles.");
    await t.click({ css: 'button[aria-label="Next Scale key"]' });
    await t.hold(700);
    await chooseOption(t, "Easing of Scale key", 1, "custom");
    await t.hold(900);
    if (await t.exists({ css: '[data-testid="ease-curve"]' })) {
      const c = await t.eval(`(()=>{const r=document.querySelector('[data-testid="ease-curve"]').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height}})()`);
      // pull the first handle down-right and the second up-left: a slow start and a fast finish with overshoot
      await t.drag(await pointOf(t, '[data-testid="ease-curve"] circle', 0, "__ease_a"), await at(t, c.l + c.w * 0.7, c.t + c.h * 0.8));
      await t.hold(500);
      await t.drag(await pointOf(t, '[data-testid="ease-curve"] circle', 1, "__ease_b"), await at(t, c.l + c.w * 0.3, c.t + c.h * 0.1));
      await t.hold(900);
    }

    t.note("Close the panel, rewind and play: the clip zooms and drifts along the keys.", "Play it back and the move follows the curves.");
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(400);
    await t.key("Home", { chip: false });
    await t.hold(400);
    await t.click({ css: "button", text: "Play", exact: true });
    await t.hold(9500);
    await t.key("Space", { chip: false });
    await t.hold(600);
    await t.still("Keyframes and easing");
    await t.rec.stop();
  },
};
