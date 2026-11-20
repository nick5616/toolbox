// 05 Audio to MIDI: the Paramore bass stem becomes a MIDI file.
export default {
  id: "audio-to-midi",
  title: "Audio to MIDI",
  tool: "Audio to MIDI",
  kind: "a",
  roles: ["stems.paramore.bass"],
  async run(t) {
    await t.rec.start();
    t.note("The bass stem turned into notes: the Bass range is picked, then the MIDI file with its note count.", "Turn a bass line or a melody into a MIDI file you can drop into any music program.");
    await t.open("audio-to-midi");
    await t.handOff("audio-to-midi", "stems.paramore.bass");
    await t.hold(800);
    await t.click({ css: '[aria-label="Range"] button', textRe: "^Bass" });
    await t.hold(700);
    await t.click({ css: "button", textRe: "^Make MIDI" });
    await t.move({ css: "main" });
    await t.waitJob({ compress: true });
    await t.hold(1500);
    await t.still("Audio to MIDI");
    await t.rec.stop();
  },
};
