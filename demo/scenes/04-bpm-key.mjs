// 04 BPM & key: the Paramore and underscores stems -> tempo and key per track.
export default {
  id: "bpm-key",
  title: "BPM and key",
  tool: "BPM & Key",
  kind: "a",
  roles: ["stems.paramore", "stems.underscores"],
  async run(t) {
    await t.rec.start();
    t.note("Eight stems from two songs analysed at once: tempo, key and Camelot code in one table.", "Drop a pile of tracks and get each one's tempo and key in a table, ready to sort and copy.");
    await t.open("bpm-key");
    await t.handOff("bpm-key", "stems.paramore", "stems.underscores");
    await t.hold(1200);
    await t.click({ css: "button", textRe: "^Analy[sz]e" });
    await t.move({ css: "main" });
    await t.waitJob({ compress: true });
    await t.hold(1500);
    await t.still("BPM and key");
    await t.rec.stop();
  },
};
