// 03 Stems: a song in, four stems out, solo the vocals.
export default {
  id: "stems",
  title: "Stems",
  tool: "Stem Splitter",
  kind: "a",
  roles: ["song.main"],
  async run(t) {
    await t.rec.start();
    t.note("One song in, four stems out (vocals, drums, bass, other); the vocals soloed.", "Split any song into vocals, drums, bass and the rest, then solo the one you want.");
    await t.open("stems");
    await t.handOff("stems", "song.main");
    await t.hold(900);
    await t.click({ css: "button", textRe: "^Split" });
    await t.move({ css: "main" });
    await t.waitJob({ compress: true });
    await t.hold(1000);
    t.note("Solo the vocals: play only that stem.");
    await t.hover({ within: '[role="group"][aria-label="Vocals"]', css: "button", text: "Play" }, 300);
    await t.click({ within: '[role="group"][aria-label="Vocals"]', css: "button", text: "Play" });
    await t.hold(3500);
    await t.still("Stems");
    await t.rec.stop();
  },
};
