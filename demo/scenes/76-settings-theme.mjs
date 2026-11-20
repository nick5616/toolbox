// 76 Settings and theme: the tool packs, the light theme on a few tools, Hide personal details, then back to dark.
const THEME = (name) => ({ css: '[aria-label="Theme"] button', text: name, exact: true });
const SETTINGS = { css: '[aria-label="Settings"]' };

export default {
  id: "settings-theme",
  title: "Settings and theme",
  tool: "Settings",
  kind: "a",
  roles: [],
  async run(t) {
    let light = false;
    try {
      await t.rec.start();
      t.note("Settings starts with the tool packs: each pack is a group of tools, installed only when you want it.", "Tools come in packs you install when you need them.");
      await t.key("Mod+,");
      await t.waitFor({ text: "Tool packs" });
      await t.hold(1800);
      await t.click({ css: "button", text: "Music", exact: true }).catch(() => {});
      await t.hold(1800);
      await t.hover({ css: "button", text: "Remove", nth: 0 }, 900);

      t.note("The theme is a choice: Light, Dark or follow the system.", "Switch the whole app to a light theme.");
      await t.scroll(SETTINGS, 520, 1400);
      await t.hold(600);
      await t.click(THEME("Light"));
      light = true;
      await t.hold(1800);

      t.note("The light theme on a few tools: the Library, the Pipelines graph, Image Batch and Transcribe.", "Every tool follows the theme.");
      await t.openLibrary();
      await t.hold(2200);
      await t.click({ text: "Pipelines" });
      await t.hold(2400);
      await t.open("imagebatch");
      await t.hold(2000);
      await t.open("transcribe");
      await t.hold(2000);

      t.note("Back in Settings, Hide personal details keeps your user name and folders off the screen.", "One switch hides your user name and folders, handy for sharing your screen.");
      await t.key("Mod+,");
      await t.waitFor({ text: "Tool packs" });
      await t.hold(600);
      await t.scroll(SETTINGS, 1600, 2400);
      await t.hold(600);
      await t.waitFor({ text: "Hide personal details" });
      await t.hover({ text: "Hide personal details" }, 2400);
      await t.still("Settings light");

      t.note("And back to the dark theme.", "And back to dark.");
      await t.scroll(SETTINGS, -2400, 1200);
      await t.scroll(SETTINGS, 520, 800);
      await t.click(THEME("Dark"));
      light = false;
      await t.hold(2000);
      await t.rec.stop();
    } finally {
      if (light) {
        // Leave the capture workspace dark even when a take failed halfway.
        await t.click(THEME("Dark")).catch(() => {});
      }
    }
  },
};
