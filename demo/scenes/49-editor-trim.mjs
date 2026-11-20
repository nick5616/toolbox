// 49 Video Editor: precise editing tools. Razor (C), ripple delete, ripple trim (B), roll (N) and slip (Y), with the
// snapping magnet, then a playback of the tightened cut. Scene 09 shows the razor and one ripple delete in passing;
// this one is the trim toolkit.
import { newVideo, at, clipRects } from "./_d2a.mjs";
import { ensurePrepared, trimHandle } from "./_d4a.mjs";

export default {
  id: "editor-trim",
  title: "Trim tools and snapping",
  tool: "Video Editor",
  kind: "a",
  roles: ["video.broll"],
  async run(t) {
    // --- untimed setup: three B-roll clips back to back (36 s), prepared, fitted.
    const broll = t.roles("video.broll");
    await newVideo(t, [broll[0], broll[1], broll[2]]);
    await t.click({ css: "button", text: "Fit", exact: true });
    await ensurePrepared(t);
    await t.key("Home", { chip: false });
    t.markJobs();

    const row0 = async () => (await clipRects(t)).filter((c) => c.row === 0);

    await t.rec.start();
    t.note("Razor (C) cuts where you click; Shift+click cuts every track.", "The razor cuts a clip wherever you click.");
    await t.key("C", { chip: true });
    let v = await row0();
    await t.click(await at(t, v[0].left + v[0].w * 0.55, v[0].y));
    v = await row0();
    const second = v[2];
    await t.click(await at(t, second.left + second.w * 0.3, second.y));
    await t.click(await at(t, second.left + second.w * 0.7, second.y));
    await t.hold(600);

    t.note("Select (V) the middle piece and Shift+Delete: it is removed and the gap closes.", "Delete a piece with Shift and the gap closes by itself.");
    await t.key("V", { chip: true });
    v = await row0();
    const middle = v[3];
    await t.click(await at(t, middle.left + middle.w * 0.5, middle.y));
    await t.hold(500);
    await t.key("Shift+Delete", { chip: true });
    await t.hold(1000);

    t.note("Ripple trim (B): drag a clip's edge and everything after it moves with it.", "The ripple trim shortens a clip and pulls the rest along.");
    await t.key("B", { chip: true });
    v = await row0();
    const first = v[0];
    const before = v.map((c) => Math.round(c.left));
    await t.drag(await trimHandle(t, first.id, "end"), await at(t, first.left + first.w - 70, first.y));
    await t.hold(900);
    const after = (await row0()).map((c) => Math.round(c.left));
    if (after.length > 1 && before.length > 1 && after[1] >= before[1]) throw new Error(`the ripple trim did not pull the next clip along: ${before} -> ${after}`);

    t.note("Roll (N): drag the cut between two clips; one gets shorter by what the other gets longer, so the total never changes.", "Roll moves the cut between two clips without changing the length.");
    await t.key("N", { chip: true });
    v = await row0();
    const cutX = v[1].left + v[1].w;
    const total = v[v.length - 1].left + v[v.length - 1].w;
    await t.drag(await at(t, cutX - 2, v[1].y, "__roll_from"), await at(t, cutX + 60, v[1].y, "__roll_to"));
    await t.hold(900);
    const v2 = await row0();
    const total2 = v2[v2.length - 1].left + v2[v2.length - 1].w;
    if (Math.abs(total2 - total) > 3) throw new Error(`the roll changed the total length: ${total} -> ${total2}`);

    t.note("Slip (Y): drag inside a clip to choose which part of the file it shows; the readout gives the new In and Out.", "Slip slides the footage inside a clip without moving the clip.");
    await t.key("Y", { chip: true });
    v = await row0();
    const target = v[v.length - 1];
    await t.drag(await at(t, target.left + target.w * 0.4, target.y, "__slip_from"), await at(t, target.left + target.w * 0.4 + 90, target.y, "__slip_to"));
    await t.hold(1200);
    await t.key("V", { chip: true });
    await t.hold(500);

    t.note("The magnet (Shift+N) turns snapping on and off: clips and the playhead stick to edges and markers.", "Snapping makes clips stick to edges; Shift N turns it off.");
    await t.key("Shift+N", { chip: true });
    await t.hold(1100);
    await t.key("Shift+N", { chip: true });
    await t.hold(900);

    await t.key("Home", { chip: false });
    await t.click({ css: "button", text: "Play", exact: true });
    await t.hold(6000);
    await t.key("Space", { chip: false });
    await t.hold(500);
    await t.still("Trim tools and snapping");
    await t.rec.stop();
  },
};
