// 06 Visualizer: a song becomes a reactive video. UNVERIFIED past the analysis (the Visualizer stayed on "Reading the
// file…" in the scratch workspace); written from the code, to be re-filmed after the preset retune merges.
// Presets are being retuned, so the scene picks the first preset in the picker rather than a named one.
export default {
  id: "visualizer",
  title: "Visualizer",
  tool: "Visualizer",
  kind: "a",
  roles: ["song.main"],
  async run(t) {
    // Untimed: hand the song over and wait for the analysis (stems + beat + sections; can take many minutes).
    await t.open("visualizer");
    await t.handOff("visualizer", "song.main");
    for (let i = 0; i < 900; i++) {
      await t.hold(3000);
      if (!(await t.exists({ text: "Analysing…" })) && !(await t.exists({ text: "Reading the file" }))) break;
    }
    await t.hold(2000);

    await t.rec.start();
    t.note("The song is analysed, a design is picked, the Intensity slider goes from calm to wild, and a short preview is rendered.", "Pick a look, set how hard it reacts to the music, and render.");
    // a preset: the first thumbnail in the picker
    if (await t.exists({ css: '[aria-label="Intensity"]' })) {
      await t.hold(1500);
      const thumb = { css: '[role="radio"], [role="option"]', nth: 0 };
      if (await t.exists(thumb)) await t.click(thumb);
      await t.hold(1500);
      await t.click({ css: '[aria-label="Intensity"]' });
      for (let i = 0; i < 6; i++) await t.key("ArrowRight", { chip: false }); // up from Balanced to Wild
      await t.hold(1500);
      for (let i = 0; i < 14; i++) await t.key("ArrowLeft", { chip: false }); // down to Calm
      await t.hold(1500);
      for (let i = 0; i < 8; i++) await t.key("ArrowRight", { chip: false }); // back to about Balanced
      await t.hold(1200);
    }
    await t.click({ css: "button", text: "Export", exact: true });
    await t.hold(1200);
    if (await t.exists({ css: "button", textRe: "^Preview" })) {
      await t.click({ css: "button", textRe: "^Preview" });
      await t.move({ css: "main" });
      await t.waitJob({ compress: true, allowFail: true, timeoutMs: 20 * 60000 });
      await t.hold(2500);
    }
    await t.still("Visualizer");
    await t.rec.stop();
  },
};
