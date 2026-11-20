// B-roll: stem waveforms. The Paramore drum and bass stems as the music of two editor projects, zoomed to fit, playing.
// (The editor has one music track, so each stem is its own short take; both go into the same clip.)
export default {
  id: "broll-stems",
  title: "Stems waveforms",
  tool: "Video Editor",
  kind: "b",
  roles: ["stems.paramore"],
  async run(t) {
    const project = async (role) => {
      await t.open("video-studio");
      if (await t.exists({ css: "button", text: "Videos" })) await t.click({ css: "button", text: "Videos" });
      await t.hold(500);
      await t.handOff("video-studio", t.role(role));
      await t.hold(1200);
      await t.click({ css: '[role="dialog"] button', text: "16:9" });
      await t.click({ css: "button", text: "Create", exact: true });
      await t.hold(4000);
      await t.click({ css: "button", text: "Fit", exact: true });
      await t.hold(800);
    };
    await project("stems.paramore.drums");
    await t.rec.start({ name: "Stems waveforms" });
    t.note("A song's stems as waveforms on the editor timeline (drums, then bass), scrolling as they play.", "");
    await t.hold(800);
    await t.click({ css: '[aria-label="Play"], button[aria-label*="lay"]' });
    await t.hold(7000);
    await t.click({ css: '[aria-label="Pause"], button[aria-label*="ause"]' }).catch(() => {});
    await t.rec.pause();
    await project("stems.paramore.bass");
    await t.rec.resume();
    await t.click({ css: '[aria-label="Play"], button[aria-label*="lay"]' });
    await t.hold(7000);
    await t.click({ css: '[aria-label="Pause"], button[aria-label*="ause"]' }).catch(() => {});
    await t.rec.stop();
    await t.reset();
  },
};
