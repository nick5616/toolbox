// B-roll: the command palette searching for tools, a few queries in a row.
const PALETTE = { css: '[role="dialog"][aria-label="Command palette"]' };

export default {
  id: "broll-palette",
  title: "Palette search",
  tool: "Toolbox",
  kind: "b",
  roles: [],
  async run(t) {
    await t.rec.start({ name: "Palette search" });
    t.note("The command palette searching for tools: stems, PDF, image, video.", "");
    await t.openLibrary();
    await t.hold(600);
    await t.key("Mod+K");
    await t.waitFor(PALETTE);
    await t.hold(700);
    for (const q of ["stem", "pdf", "background", "subtitle", "gif"]) {
      await t.type(null, q);
      await t.hold(1100);
      await t.key("ArrowDown", { chip: false });
      await t.hold(350);
      await t.key("Mod+A", { chip: false });
      await t.key("Backspace", { chip: false });
      await t.hold(250);
    }
    await t.type(null, "transcribe");
    await t.hold(1000);
    await t.key("Escape", { chip: false });
    await t.hold(900);
    await t.rec.stop();
  },
};
