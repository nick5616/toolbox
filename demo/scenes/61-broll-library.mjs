// B-roll: a slow scroll through the Library grid.
export default {
  id: "broll-library",
  title: "Library scroll",
  tool: "Library",
  kind: "b",
  roles: [],
  async run(t) {
    await t.rec.start({ name: "Library scroll" });
    t.note("A slow scroll down the Library grid: photos, results, documents side by side.", "");
    await t.openLibrary();
    await t.hold(1200);
    await t.scroll(null, 900, 7000);
    await t.hold(600);
    await t.scroll(null, 900, 7000);
    await t.hold(600);
    await t.scroll(null, -1500, 6000);
    await t.hold(800);
    await t.rec.stop();
  },
};
