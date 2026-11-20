// B-roll: the sidebar scrolls through its categories while a few tools open one after another.
const SIDEBAR_SCROLL = { css: '[aria-label="Sidebar"] [class*="_scroll_"]' };

export default {
  id: "broll-sidebar",
  title: "Sidebar glide",
  tool: "Toolbox",
  kind: "b",
  roles: [],
  async run(t) {
    await t.rec.start({ name: "Sidebar glide" });
    t.note("Gliding down the sidebar: tools grouped by category, opening a few of them.", "");
    await t.openLibrary();
    await t.hold(1200);
    await t.open("stems");
    await t.hold(1500);
    await t.scroll(SIDEBAR_SCROLL, 380, 2600);
    await t.open("transcribe");
    await t.hold(1500);
    await t.scroll(SIDEBAR_SCROLL, 380, 2600);
    for (const id of ["converter", "imagebatch"]) {
      if (await t.exists({ css: `[data-testid="nav-${id}"] button` })) {
        await t.open(id);
        await t.hold(1500);
      }
    }
    await t.scroll(SIDEBAR_SCROLL, 380, 2600);
    for (const id of ["pdf", "bg-remover"]) {
      if (await t.exists({ css: `[data-testid="nav-${id}"] button` })) {
        await t.open(id);
        await t.hold(1500);
      }
    }
    await t.scroll(SIDEBAR_SCROLL, 600, 2400);
    await t.hold(800);
    await t.scroll(SIDEBAR_SCROLL, -2000, 3500);
    await t.hold(600);
    await t.openLibrary();
    await t.hold(1000);
    await t.rec.stop();
  },
};
