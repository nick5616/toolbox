// B-roll: the editor timeline playing: a project with four clips and a song, a text track and a second video track added.
export default {
  id: "broll-editor",
  title: "Editor timeline",
  tool: "Video Editor",
  kind: "b",
  roles: ["video.broll", "song.short.tickle"],
  async run(t) {
    // Set up the project off camera (the preview copies need a moment).
    await t.open("video-studio");
    if (await t.exists({ css: "button", text: "Videos" })) await t.click({ css: "button", text: "Videos" });
    await t.hold(600);
    await t.handOff("video-studio", ...t.roles("video.broll").slice(0, 4), t.role("song.short.tickle"));
    await t.hold(1200);
    await t.click({ css: '[role="dialog"] button', text: "16:9" });
    await t.click({ css: "button", text: "Create", exact: true });
    await t.hold(14000);
    for (const kind of ["Video track", "Text"]) {
      await t.click({ css: "button", text: "Add", exact: true });
      await t.click({ text: kind });
      await t.hold(600);
    }
    await t.click({ css: "button", text: "Fit", exact: true });
    await t.rec.start({ name: "Editor timeline" });
    t.note("The editor's multitrack timeline playing: clips on a video track, an empty second video track and a text track, and the song's waveform beneath.", "");
    await t.hold(800);
    await t.click({ css: '[aria-label="Play"], button[aria-label*="lay"]' });
    await t.hold(14000);
    await t.click({ css: '[aria-label="Pause"], button[aria-label*="ause"]' }).catch(() => {});
    await t.rec.stop();
    await t.reset();
  },
};
