// 00 Tour: the smoke scene. Sidebar categories, palette search, a song dropped on the window.
export default {
  id: "tour",
  title: "Tour",
  tool: "Toolbox",
  kind: "a",
  roles: ["song.main"],
  async run(t) {
    await t.rec.start();

    t.note("The sidebar groups the tools by what they do.", "Everything lives in one sidebar, grouped by what you want to do.");
    await t.hover({ css: '[data-testid="nav-stems"] button' }, 900);
    await t.hover({ css: '[data-testid="nav-visualizer"] button' }, 700);
    await t.hover({ css: '[data-testid="nav-video-studio"] button' }, 700);

    t.note("Search finds tools and actions: \"stems\".", "Or just search for what you need.");
    await t.key("Mod+K");
    await t.type(null, "stems");
    await t.hold(1200);
    await t.key("Escape", { chip: false });
    await t.hold(500);

    t.note("Drop a song on the window and Toolbox suggests the tools that take it.", "Drop a file anywhere and it offers the tools that can use it.");
    await t.handOff(null, "song.main");
    await t.hold(2200);

    await t.still("Tour");
    await t.rec.stop(); // the end handle holds on the suggestions
    await t.reset();
  },
};
