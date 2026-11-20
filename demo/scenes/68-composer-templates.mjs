// 68 Photo Composer, layouts, text, background and export: four photos on a Story canvas, the four layouts, a gradient
// background, a text layer with a pill and another font, then the export with its results row.
import { chooseOption } from "./_d2a.mjs";

export default {
  id: "composer-templates",
  title: "Photo Composer layouts and text",
  tool: "Photo Composer",
  kind: "a",
  roles: ["photo.park", "photo.painting", "photo.skyline", "photo.ferris"],
  async run(t) {
    await t.rec.start();
    t.note(
      "A new composition in Photo Composer: the canvas shape is set to Story 9:16, four photos are dropped in, and the four layouts (Scatter, Grid, Stack, Polaroids) place them. The background becomes a gradient, a text layer is added and typed, given a pill and another font, and the finished picture is exported as JPG.",
      "Lay out photos on any canvas shape, add a gradient background and a caption, and export. Every layout is one click."
    );
    await t.open("photo-composer");
    if (!(await t.exists({ text: "New composition" }))) await t.click({ css: "button", text: "Projects" });
    await t.click({ text: "New composition" });
    await t.hold(600);
    await t.click({ css: '[role="dialog"] input' });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "Weekend story");
    await t.click({ css: "button", text: "Create", exact: true });
    await t.hold(1100);

    // The canvas: a tall Story shape.
    await t.click({ text: "Canvas" });
    await t.hold(800);
    await chooseOption(t, "Canvas shape", 4, "Story");
    await t.hold(1200);
    await t.click({ css: '[aria-label="Close"]' }).catch(() => {});
    await t.hold(400);

    await t.handOff("photo-composer", t.role("photo.park"), t.role("photo.painting"), t.role("photo.skyline"), t.role("photo.ferris"));
    await t.hold(2200);

    // Every layout.
    await t.click({ text: "Layouts" });
    await t.hold(700);
    for (const name of ["Scatter", "Grid", "Stack", "Polaroids"]) {
      await t.click({ css: "button", textRe: `^${name}` });
      await t.hold(1200);
    }
    await t.click({ css: "button", textRe: "^Polaroids" });
    await t.hold(1000);
    await t.click({ css: '[aria-label="Close"]' }).catch(() => {});
    await t.hold(400);

    // Background: a gradient.
    await t.click({ text: "Background" });
    await t.hold(800);
    await t.click({ css: '[aria-label="Background kind"] button', text: "Gradient", exact: true });
    await t.hold(1600);
    await t.click({ css: '[aria-label="Background kind"] button', text: "Colour", exact: true });
    await t.hold(900);
    await t.click({ css: '[aria-label="Background kind"] button', text: "Gradient", exact: true });
    await t.hold(1200);
    await t.click({ css: '[aria-label="Close"]' }).catch(() => {});
    await t.hold(400);

    // Text.
    await t.click({ css: '[aria-label="More actions"]' });
    await t.hold(600);
    await t.click({ text: "Add text", exact: true });
    await t.hold(1200);
    await t.click({ text: "Text style" });
    await t.hold(800);
    await t.click({ css: 'textarea[aria-label="Text"]' });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "Weekend in the city");
    await t.hold(900);
    await t.click({ css: "label", text: "Bold" });
    await t.hold(500);
    await t.click({ css: "label", text: "Background pill" });
    await t.hold(1200);
    await chooseOption(t, "Font", 2);
    await t.hold(1800);
    await t.click({ css: '[aria-label="Close"]' }).catch(() => {});
    await t.hold(500);
    await t.still("Photo Composer layout and text");

    // Export.
    await t.click({ css: "button", text: "Export" });
    await t.hold(700);
    await t.click({ css: "button", text: "Export as JPG" });
    await t.hold(4500);
    await t.still("Photo Composer story export");
    await t.rec.stop();
  },
};
