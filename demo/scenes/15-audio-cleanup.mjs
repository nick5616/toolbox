// 15 Audio Cleanup: the noisy narration becomes clean.
export default {
  id: "audio-cleanup",
  title: "Audio Cleanup",
  tool: "Audio Cleanup",
  kind: "a",
  roles: ["audio.noisy"],
  async run(t) {
    await t.rec.start();
    t.note("Hiss and a 60 Hz hum removed, loudness levelled; the result sits next to the original for an A/B listen.", "Remove hiss and hum, level the volume, and compare before and after.");
    await t.open("audio-cleanup");
    await t.handOff("audio-cleanup", "audio.noisy");
    await t.hold(1500);
    // Voice isolation needs a model download; the Strong filter is already there.
    if (await t.exists({ css: "button", text: "Use Strong instead" })) await t.click({ css: "button", text: "Use Strong instead" });
    await t.hold(900);
    await t.click({ css: "button", textRe: "^Clean \\d+ files?" });
    await t.move({ css: "main" });
    await t.waitJob({ compress: true });
    await t.hold(1200);
    t.note("Before and after: the loudness column and the 10 s preview play the cleaned sound.");
    await t.click({ css: "button", textRe: "^Preview 10 s" });
    await t.hold(3500);
    await t.still("Audio Cleanup");
    await t.rec.stop();
  },
};
