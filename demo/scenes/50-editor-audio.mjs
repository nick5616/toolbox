// 50 Video Editor: audio tracks. The narration's sound is detached onto its own (linked) clip, a song goes on a second
// audio track, the song gets a lower volume line and fade handles, a track is soloed and muted, and it plays.
// Scene 11 shows detach plus a volume dip on the narration; this one mixes two audio tracks.
import { newVideo, at, clipRects, rowY, addFromLibrary } from "./_d2a.mjs";
import { ensurePrepared, pointOf } from "./_d4a.mjs";

export default {
  id: "editor-audio",
  title: "Audio tracks and mixing",
  tool: "Video Editor",
  kind: "a",
  roles: ["video.talk", "song.short.intense"],
  async run(t) {
    // --- untimed setup: the narration video as a new edit, two audio tracks, the song in Sources.
    await newVideo(t, [t.role("video.talk")]);
    await t.click({ css: "button", text: "Fit", exact: true });
    await ensurePrepared(t);
    for (let i = 0; i < 2; i++) {
      await t.click({ css: "button", text: "Add", exact: true });
      await t.click({ css: '[role="menuitem"]', text: "Audio track" });
      await t.hold(500);
    }
    await t.click({ css: "button", text: "Media", exact: true });
    await t.hold(500);
    await addFromLibrary(t, "song.short.intense");
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(500);
    await t.key("Home", { chip: false });
    t.markJobs();

    await t.rec.start();
    t.note("Detach audio: the narration's sound becomes its own clip on an audio track, linked to the picture; the waveform shows on the clip.", "Right-click, detach audio, and the narration is its own clip with a waveform.");
    const v = (await clipRects(t)).find((c) => c.row === 0);
    if (!v) throw new Error("no video clip");
    await t.click(await at(t, v.left + v.w * 0.5, v.y), { right: true });
    await t.hold(500);
    await t.click({ css: '[role="menu"] [role="menuitem"]', text: "Detach audio" });
    await t.hold(1500);

    t.note("The song comes from Media onto the second audio track.", "Drop a song on the track below it.");
    await t.click({ css: "button", text: "Media", exact: true });
    await t.hold(600);
    const yMusic = await rowY(t, 2);
    await t.drag({ css: '[aria-label*="INTENSE"]' }, await at(t, 430, yMusic));
    await t.hold(800);
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(600);

    // taller audio tracks: the waveforms and the volume line are easier to see and to grab
    for (const idx of [2, 1]) {
      const g = await t.eval(`(()=>{const e=document.querySelectorAll('[data-grow-track]')[${idx}];if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
      if (g) await t.drag(await at(t, g.x, g.y, "__grow_from"), await at(t, g.x, g.y + 70, "__grow_to"));
      await t.hold(400);
    }
    const music = (await clipRects(t)).find((c) => c.row === 2);
    if (!music) throw new Error("the song did not land on the second audio track");
    await t.click(await at(t, music.left + music.w * 0.12, music.top + 6)); // select it
    await t.hold(700);
    const gainPts = `(()=>{const s=document.querySelector('[data-gain-line="${music.id}"]');const p=s&&s.querySelector('polyline[class*="gainLine"]');return p?p.getAttribute('points'):null})()`;
    const pts0 = await t.eval(gainPts);
    const zeroY = await t.eval(`(()=>{const s=document.querySelector('[data-gain-line="${music.id}"]');const p=s&&s.querySelector('polyline[class*="gainLine"]');if(!p)return null;return s.getBoundingClientRect().top+parseFloat(p.getAttribute('points').split(' ')[0].split(',')[1])})()`);
    if (zeroY === null) throw new Error("the volume line is not showing");

    t.note("The volume line: drag it down to lower the whole song under the narration.", "Pull the line down and the song sits under the voice.");
    await t.drag(await at(t, music.left + music.w * 0.5, zeroY, "__gain_from"), await at(t, music.left + music.w * 0.5, zeroY + 22, "__gain_to"));
    await t.hold(1000);
    if ((await t.eval(gainPts)) === pts0) throw new Error("the volume line did not move");

    t.note("The corner handles are the fades: the song comes in and dies away softly.", "Drag the corner handles to fade in and out.");
    await t.drag(await pointOf(t, `[data-gain-line="${music.id}"] circle[class*="fadeHandle"]`, 1, "__fade_out"), await at(t, music.left + music.w - 120, music.top + 5));
    await t.drag(await pointOf(t, `[data-gain-line="${music.id}"] circle[class*="fadeHandle"]`, 0, "__fade_in"), await at(t, music.left + 80, music.top + 5));
    await t.hold(1000);

    t.note("Solo a track to hear just it; Mute silences one.", "Solo the voice to hear only it, mute the song, or bring them both back.");
    await t.click({ css: '[data-track-header] button[aria-label="Solo track"]', nth: 1 });
    await t.hold(1200);
    await t.click({ css: '[data-track-header] button[aria-label="Unsolo track"]' });
    await t.hold(600);

    await t.key("Home", { chip: false });
    await t.click({ css: "button", text: "Play", exact: true });
    await t.hold(7000);
    await t.key("Space", { chip: false });
    await t.hold(500);
    await t.still("Audio tracks and mixing");
    await t.rec.stop();
  },
};
