// 47 Video Editor: a green-screen clip over a city background with the one-click "Green screen" stack, the
// eyedropper to refine the key, the matte view, then the picture-in-picture presets.
import { newVideo, at, clipRects, rowY, chooseOption, addFromLibrary } from "./_d2a.mjs";
import { ensurePrepared } from "./_d4a.mjs";

export default {
  id: "editor-greenscreen",
  title: "Green screen and picture-in-picture",
  tool: "Video Editor",
  kind: "a",
  roles: ["video.broll", "video.green.snoop"],
  async run(t) {
    // --- untimed setup: two B-roll clips as the background (24 s), a second video track, the green clip put on it once
    // so its edit stream is made, then taken off again (the filmed part drops it back on).
    const broll = t.roles("video.broll");
    await newVideo(t, [broll[2], broll[3]]);
    await t.click({ css: "button", text: "Fit", exact: true });
    await t.click({ css: "button", text: "Add", exact: true });
    await t.click({ css: '[role="menuitem"]', text: "Video track" });
    await t.hold(500);
    await t.click({ css: "button", text: "Media", exact: true });
    await t.hold(500);
    await addFromLibrary(t, "video.green.snoop");
    const yTop = await rowY(t, 0);
    await t.drag({ css: '[aria-label="Snoop Dog Dancing.mp4"]' }, await at(t, 420, yTop));
    await t.hold(600);
    await t.click({ css: "button", text: "Close", exact: true });
    await ensurePrepared(t);
    let first = (await clipRects(t)).find((c) => c.row === 0);
    if (!first) throw new Error("the green clip did not land on the top track");
    await t.click(await at(t, first.left + 60, first.y));
    await t.key("Delete", { chip: false });
    await t.hold(600);
    await t.key("Home", { chip: false });
    t.markJobs();

    await t.rec.start();
    t.note("A green-screen clip goes on the track above the city background.", "Drop the green-screen clip on the track above your background.");
    await t.click({ css: "button", text: "Media", exact: true });
    await t.hold(600);
    await t.drag({ css: '[aria-label="Snoop Dog Dancing.mp4"]' }, await at(t, 420, yTop));
    await t.hold(700);
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(500);
    const clips = await clipRects(t);
    const green = clips.find((c) => c.row === 0);
    if (!green) throw new Error("the green clip did not land on the top track");
    await t.click(await at(t, green.left + Math.min(green.w * 0.3, 120), green.y));
    await t.hold(800);

    t.note("Effects, Add effect, Green screen: one click keys the green, trims the edge and removes the green spill.", "One click on the Green screen stack, and the green is gone.");
    await t.click({ css: "button", text: "Effects", exact: true });
    await t.click({ css: "button", text: "Add effect", exact: true });
    await t.type(null, "green screen");
    await t.hold(500);
    await t.key("Enter", { chip: false });
    await t.hold(1200);

    t.note("The eyedropper refines the key: press Pick and click the green on the preview.", "If the green is a different shade, pick it straight from the picture.");
    await t.click({ css: "button", text: "Pick", exact: true });
    await t.hold(400);
    await t.click(await at(t, 680, 110));
    await t.hold(1500);

    t.note("Matte view: white is kept, black is removed. Then back to the composite.");
    // the eyedropper click closed the drawer: reopen it and expand the effect
    await t.click({ css: "button", text: "Effects", exact: true });
    await t.hold(600);
    if (!(await t.exists({ css: 'select[aria-label="View"]' }))) await t.click({ text: "Chroma key", exact: true, nth: 0 });
    await t.hold(500);
    await chooseOption(t, "View", 1, "matte");
    await t.hold(1400);
    await chooseOption(t, "View", -1, "composite");
    await t.hold(1200);

    t.note("Transform, Picture-in-picture: park the keyed clip in a corner, then the other half of the frame.", "Presets put the clip in a corner or half the frame in one click.");
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(400);
    await t.click({ css: "button", text: "Transform", exact: true });
    await t.hold(700);
    for (const where of ["Bottom right", "Top left"]) {
      await t.click({ css: "button", text: "Picture-in-picture" });
      await t.click({ css: '[role="menuitem"]', text: where });
      await t.hold(1500);
    }
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(400);
    await t.click({ css: "button", text: "Play", exact: true });
    await t.hold(2200);
    await t.key("Space", { chip: false });
    await t.hold(600);
    await t.still("Green screen and picture-in-picture");
    await t.rec.stop();
  },
};
