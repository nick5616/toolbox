// 14 Silence Cutter: the narration video with its pauses removed.
export default {
  id: "silence",
  title: "Silence Cutter",
  tool: "Silence Cutter",
  kind: "a",
  roles: ["video.talk"],
  async run(t) {
    await t.rec.start();
    t.note("The pauses between the narration's paragraphs are found and cut out; the cut list shows what went.", "Cut the dead air out of a recording in one click.");
    await t.open("silence");
    await t.handOff("silence", "video.talk");
    await t.hold(1500);
    await t.click({ css: "button", textRe: "^Cut" });
    await t.move({ css: "main" });
    await t.waitJob({ compress: true });
    await t.hold(1500);
    await t.still("Silence Cutter");
    await t.rec.stop();
  },
};
