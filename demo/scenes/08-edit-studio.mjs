// 08 Edit Studio: B-roll plus a short song, Auto-fill's "Cut to the beat", then play.
export default {
  id: "edit-studio",
  title: "Edit Studio",
  tool: "Edit Studio",
  kind: "a",
  roles: ["video.broll", "song.short.tickle"],
  async run(t) {
    await t.rec.start();
    t.note("The song's beats become cut points: the six B-roll clips are cut to the beat.", "Give it clips and a song and it cuts the clips to the beat.");
    await t.open("edit-studio");
    if (await t.exists({ css: "button", text: "Edits", exact: true })) await t.click({ css: "button", text: "Edits", exact: true });
    await t.handOff("edit-studio", "song.short.tickle", "video.broll");
    await t.hold(1200);
    await t.click({ css: '[role="radio"]', text: "16:9" });
    await t.click({ css: '[role="dialog"] button', text: "Create" });
    await t.move({ css: "main" });
    await t.hold(2500);
    await t.waitJob({ compress: true, allowFail: true });
    await t.hold(1500);
    t.note("Analyze finds the song's beats, sections and mood; this takes a minute or two.");
    if (await t.exists({ css: "button", text: "Analyze", exact: true })) {
      await t.click({ css: "button", text: "Analyze", exact: true });
      await t.move({ css: "main" });
      await t.waitJob({ compress: true });
    } else {
      await t.click({ css: "button", text: "Use it", exact: true }); // an analysis from an earlier take
    }
    await t.hold(2500);
    await t.click({ css: "button", text: "15 s from here" });
    await t.hold(500);
    await t.click({ css: "button", text: "Use this range" });
    await t.hold(1500);
    await t.still("Edit Studio analysed");
    await t.click({ css: "button", text: "Auto-fill" });
    await t.hold(1500);
    t.note("Auto-fill recipe \"Kick cuts\": a cut on every kick drum.");
    await t.click({ css: '[role="radio"]', textRe: "^Kick cuts" });
    await t.hold(1000);
    await t.click({ css: "button", text: "Apply", exact: true });
    await t.move({ css: "main" });
    await t.hold(2500);
    await t.click({ css: "button", text: "Play", exact: true });
    await t.hold(5000);
    await t.key("Space", { chip: false });
    await t.still("Edit Studio");
    await t.rec.stop();
  },
};
