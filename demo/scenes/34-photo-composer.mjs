// 34 Photo Composer: a new composition, photos dropped in, a layout places them, export.
export default {
  id: "photo-composer",
  title: "Photo Composer",
  tool: "Photo Composer",
  kind: "a",
  roles: ["photo.park", "photo.dessert", "photo.flowers", "photo.ferris"],
  async run(t) {
    await t.rec.start();
    t.note(
      "A new composition, four photos dropped on it, then the Polaroids layout places them and Shuffle rearranges; exported as one picture.",
      "Layer photos into one image; pick a layout and every photo finds its place."
    );
    await t.open("photo-composer");
    if (!(await t.exists({ text: "New composition" }))) await t.click({ css: "button", text: "Projects" });
    await t.click({ text: "New composition" });
    await t.hold(600);
    await t.click({ css: '[role="dialog"] input' });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "Weekend collage");
    await t.click({ css: "button", text: "Create", exact: true });
    await t.hold(1800);
    await t.handOff("photo-composer", t.role("photo.park"), t.role("photo.dessert"), t.role("photo.flowers"), t.role("photo.ferris"));
    await t.hold(2500);
    await t.click({ text: "Layouts" });
    await t.hold(700);
    await t.click({ css: "button", textRe: "^Polaroids" });
    await t.hold(2200);
    await t.click({ css: "button", textRe: "^Shuffle" });
    await t.hold(1800);
    await t.click({ css: "button", textRe: "^Grid" });
    await t.hold(1800);
    await t.click({ css: "button", textRe: "^Polaroids" });
    await t.hold(1500);
    await t.click({ css: "button", text: "Export" });
    await t.hold(700);
    await t.click({ css: "button", text: "Export as JPG" });
    await t.hold(3500);
    await t.still("Photo Composer export");
    await t.rec.stop();
  },
};
