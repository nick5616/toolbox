// 52 Visualizer: the designer. Presets browsed live on the song, the Intensity stops (Calm, Wild, Balanced), the palette,
// a layer switched off and on, and the design saved as "my preset". Scene 06 shows analyse, pick and render; this one is
// the designing.
import { waitAnalysis, openRow, closeDrawer } from "./_d4a-viz.mjs";

export default {
  id: "visualizer-designer",
  title: "Designer and saved presets",
  tool: "Visualizer",
  kind: "a",
  roles: ["song.main"],
  async run(t) {
    // --- untimed: the song, analysed (cached after the first time).
    await t.open("visualizer");
    await t.handOff("visualizer", "song.main");
    await waitAnalysis(t);
    await t.hold(1000);

    await t.rec.start();
    t.note("The song plays through the design; the Presets list shows every design live on this song.", "Press play and every preset is a live picture of your song.");
    await t.click({ css: 'button[aria-label="Play"]' });
    await t.hold(1200);
    await openRow(t, "Presets");
    await t.hold(1800);

    t.note("Click a preset and the preview switches at once.", "Click a look and it takes over the preview.");
    for (const name of ["Neon Highway", "Nebula", "Kaleido Bloom", "Particle Storm"]) {
      await t.click({ css: `[aria-label="Designs"] button[aria-label=${JSON.stringify(name)}]` });
      await t.hold(2300);
    }
    await closeDrawer(t);
    await t.hold(500);

    t.note("Look: Intensity goes from Calm to Wild, and the palettes colour the design.", "Intensity turns the reaction from calm to wild, and you can recolour it.");
    await openRow(t, "Look");
    await t.click({ css: '[aria-label="Intensity stops"] [role="radio"]', text: "Calm" });
    await t.hold(2600);
    await t.click({ css: '[aria-label="Intensity stops"] [role="radio"]', text: "Wild" });
    await t.hold(2600);
    await t.click({ css: '[aria-label="Intensity stops"] [role="radio"]', text: "Balanced" });
    await t.hold(800);
    if (await t.exists({ css: '[aria-label="Palettes"] button', nth: 3 })) {
      await t.click({ css: '[aria-label="Palettes"] button', nth: 3 });
      await t.hold(1500);
      await t.click({ css: '[aria-label="Palettes"] button', nth: 5 });
      await t.hold(1800);
    }
    await closeDrawer(t);
    await t.hold(500);

    t.note("Layers: every part of the design can be hidden and shown again.", "Switch a layer off to see what it adds, then bring it back.");
    await openRow(t, "Layers");
    await t.hold(1200);
    if (await t.exists({ css: '[aria-label="Layer stack"] button[aria-label^="Hide"]' })) {
      await t.click({ css: '[aria-label="Layer stack"] button[aria-label^="Hide"]', nth: 0 });
      await t.hold(2300);
      await t.click({ css: '[aria-label="Layer stack"] button[aria-label^="Show"]', nth: 0 });
      await t.hold(1500);
    }
    await closeDrawer(t);
    await t.hold(500);

    t.note("Save as my preset: the tweaked design goes to the top of the Presets list under a name you choose.", "Happy with it? Save it under your own name.");
    await openRow(t, "Presets");
    await t.click({ css: "button", text: "Save as my preset" });
    await t.hold(500);
    await t.click({ css: 'input[aria-label="Preset name"]' });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "Night drive");
    await t.key("Enter", { chip: false });
    await t.hold(2500);
    await t.still("Designer and saved presets");
    await closeDrawer(t);
    await t.click({ css: 'button[aria-label="Pause"]' }).catch(() => {});
    await t.rec.stop();
  },
};
