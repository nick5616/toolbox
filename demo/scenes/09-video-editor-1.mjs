// 09 Video Editor I: multitrack editing. Razor, ripple delete, a blue-screen clip keyed with the chroma key, a keyframed PiP with Ease out.
import { newVideo, at, clipRects, rowY, selectValue, addFromLibrary } from "./_d2a.mjs";

export default {
  id: "video-editor-1",
  title: "Video Editor I",
  tool: "Video Editor",
  kind: "a",
  roles: ["video.broll", "video.blue"],
  async run(t) {
    // --- untimed setup: a 36 s edit of three B-roll clips, a second video track, the blue-screen clip in Sources.
    const broll = t.roles("video.broll");
    await newVideo(t, [broll[0], broll[1], broll[2]]);
    await t.click({ css: "button", text: "Fit", exact: true });
    await t.click({ css: "button", text: "Add", exact: true });
    await t.click({ css: '[role="menuitem"]', text: "Video track" });
    await t.hold(500);
    await t.click({ css: "button", text: "Media", exact: true });
    await t.hold(500);
    await addFromLibrary(t, "video.blue");
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(600);
    t.markJobs();

    await t.rec.start();
    t.note("The editor: razor (C) cuts, Select (V) picks, Shift+Delete ripple-deletes and closes the gap.", "Cut with the razor, delete a piece, and the gap closes by itself.");

    // 1. razor cuts: one in the first clip, two in the second
    await t.key("C", { chip: true });
    let clips = await clipRects(t);
    const v1 = clips.filter((c) => c.row === 1);
    const [rain, bridge] = v1;
    await t.click(await at(t, rain.left + rain.w * 0.55, rain.y));
    await t.click(await at(t, bridge.left + bridge.w * 0.3, bridge.y));
    await t.click(await at(t, bridge.left + bridge.w * 0.7, bridge.y));
    await t.hold(500);

    // 2. select the middle piece and ripple delete it
    await t.key("V", { chip: true });
    await t.click(await at(t, bridge.left + bridge.w * 0.5, bridge.y));
    await t.hold(500);
    await t.key("Shift+Delete", { chip: true });
    await t.hold(900);

    // 3. the blue-screen clip from Media onto the second track
    t.note("Drag the blue-screen clip from Media onto the top video track.");
    await t.click({ css: "button", text: "Media", exact: true });
    await t.hold(500);
    const y2 = await rowY(t, 0);
    await t.drag({ css: '[aria-label="Wally.mp4"]' }, await at(t, 470, y2));
    await t.hold(600);
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(400);

    // 4. key it: Effects -> Chroma key -> Pick, then click the blue
    t.note("Chroma key: add it, press Pick and click the blue on the preview.", "Pick the colour straight from the picture and the blue screen is gone.");
    clips = await clipRects(t);
    const wally = clips.find((c) => c.row === 0);
    await t.click(await at(t, wally.left + wally.w * 0.5, wally.y));
    await t.click({ css: "button", text: "Effects", exact: true });
    await t.click({ css: "button", text: "Add effect", exact: true });
    await t.type(null, "chroma");
    await t.key("Enter", { chip: false });
    await t.hold(700);
    await t.click({ css: "button", text: "Pick", exact: true });
    await t.hold(400);
    await t.click(await at(t, 720, 300));
    await t.hold(1500);

    // 5. a keyframed picture-in-picture with Ease out
    t.note("Picture-in-picture with keyframes: key position and scale, then move it into the corner with Ease out.", "Park it in the corner with a keyframed move that eases out.");
    // (he is in frame from about a third of the way into the clip to two thirds)
    await t.click(await at(t, wally.left + wally.w * 0.36, wally.y));
    await t.hold(700);
    await t.click({ css: "button", text: "Transform", exact: true });
    await t.hold(700);
    for (const p of ["Position x", "Position y", "Scale"]) await t.click({ css: `button[aria-label="Add ${p} key"]` });
    await t.hold(400);
    for (const p of ["Position x", "Position y", "Scale"]) {
      if (await t.exists({ css: `button[aria-label="Add ${p} key"]` })) await t.click({ css: `button[aria-label="Add ${p} key"]` });
    }
    await t.click(await at(t, wally.left + wally.w * 0.66, wally.y)); // clicking the timeline closes the drawer
    await t.hold(700);
    await t.click({ css: "button", text: "Transform", exact: true });
    await t.hold(400);
    await t.click({ css: "button", text: "Picture-in-picture" });
    await t.click({ css: '[role="menuitem"]', text: "Bottom right" });
    await t.hold(900);
    // back to the first key, set its ease
    await t.click({ css: 'button[aria-label="Previous Scale key"]' });
    await t.hold(400);
    for (const p of ["Position x", "Position y", "Scale"]) {
      await t.click({ css: `select[aria-label="Easing of ${p} key"]` });
      await t.key("ArrowUp", { chip: false });
      await t.key("ArrowUp", { chip: false });
      await t.key("Enter", { chip: false });
      await t.hold(300);
    }
    console.log("THIN:", await t.eval(`JSON.stringify([...document.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.width<=3&&r.height>150}).map(e=>e.className+'|'+(e.getAttribute('data-tip')||'')+'|'+Math.round(e.getBoundingClientRect().left)))`));
    const ease = await selectValue(t, "Easing of Scale key");
    if (!/ease out/i.test(ease ?? "")) throw new Error(`the ease did not change: ${ease}`);

    // 6. play it
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(400);
    await t.click({ css: "button", text: "Play", exact: true });
    await t.hold(4500);
    await t.key("Space", { chip: false });
    await t.hold(800);
    await t.still("Video Editor I");
    await t.rec.stop();
  },
};
