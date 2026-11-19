// 12 Transcribe: the narration video becomes a transcript; click a word to jump there.
export default {
  id: "transcribe",
  title: "Transcribe",
  tool: "Transcribe",
  kind: "a",
  roles: ["video.talk"],
  async run(t) {
    await t.rec.start();
    t.note("The narration video transcribed on this computer; clicking a word seeks to it.", "Turn speech into text without it leaving your computer, and click any word to jump to it.");
    await t.open("transcribe");
    await t.handOff("transcribe", "video.talk");
    await t.hold(900);
    await t.click({ css: "button", textRe: "^Transcribe \\d+ files?" });
    await t.move({ css: "main" });
    await t.waitJob({ compress: true });
    await t.hold(1200);
    await t.click({ css: "button", text: "Preview", exact: true });
    await t.hold(1800);
    await t.still("Transcribe");    await t.rec.stop();
  },
};
