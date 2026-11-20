// 13 Subtitles: generate from the narration video, style them, burn them in.
export default {
  id: "subtitles",
  title: "Subtitles",
  tool: "Subtitles",
  kind: "a",
  roles: ["video.talk"],
  async run(t) {
    await t.rec.start();
    t.note("Subtitles generated from the narration, styled, then burned into a copy of the video.", "Generate subtitles, style them, and burn them in.");
    await t.open("subtitles");
    await t.handOff("subtitles", "video.talk");
    await t.hold(1200);
    if (await t.exists({ css: "button", text: "Generate subtitles" })) {
      await t.click({ css: "button", text: "Generate subtitles" });
      await t.move({ css: "main" });
      await t.waitJob({ compress: true });
    }
    await t.hold(1500);
    t.note("Pick a look: the boxed style, large.");
    await t.click({ css: "button", text: "Style", exact: true });
    await t.hold(1000);
    await t.click({ css: "button", textRe: "Boxed$" });
    await t.hold(700);
    await t.click({ css: "button", text: "Large", exact: true });
    await t.hold(1500);
    await t.click({ css: "button", text: "Export", exact: true });
    await t.hold(900);
    await t.click({ css: "button", text: "Burn into the video" });
    await t.move({ css: "main" });
    await t.waitJob({ compress: true, moduleId: undefined });
    await t.hold(1500);
    await t.still("Subtitles");
    await t.rec.stop();
  },
};
