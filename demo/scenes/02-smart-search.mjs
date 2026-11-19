// 02 Smart search: find pictures by what is in them, and words by what a video says.
import { waitIndexed } from "./_d2a.mjs";

const BOX = { css: '[aria-label="Search the library"]' };
const OPTION = { css: '[role="listbox"] [role="option"]' };

async function clearSearch(t) {
  await t.click(BOX);
  await t.key("Mod+A", { chip: false });
  await t.key("Backspace", { chip: false });
}

export default {
  id: "smart-search",
  title: "Smart search",
  tool: "Library search",
  kind: "a",
  roles: ["photo.skyline", "video.talk"],
  async run(t) {
    await t.openLibrary();
    await waitIndexed(t); // untimed: the index has to be finished first

    await t.rec.start();
    t.note("Search by what is in the pictures: \"ferris wheel\", \"rain at night\", \"dessert\", \"code\".", "Type what you remember, not what you named it, and Toolbox finds the picture.");
    await t.hold(800);
    for (const q of ["ferris wheel", "rain at night", "dessert", "code"]) {
      await clearSearch(t);
      await t.type(BOX, q);
      await t.hold(2400);
    }

    t.note("A phrase said in the narration video finds that video, at the moment it is said.", "It also listens: a phrase from a video finds the exact moment.");
    await clearSearch(t);
    await t.type(BOX, "four on the floor");
    await t.hold(2600);
    await t.still("Smart search");

    t.note("Find similar on the skyline photo: the pictures that look most like it.", "Pick one picture and ask for more like it.");
    await clearSearch(t);
    await t.type(BOX, "city skyline at dusk");
    await t.hold(1800);
    await t.click(OPTION);
    await t.hold(1200);
    await t.click({ css: "button", text: "Find similar" });
    await t.hold(3000);
    await t.rec.stop();
  },
};
