// 56 Color Grader, Chaos and the LUT: Surprise me and Again with the seed on screen, lock a step so it survives rerolls,
// type a seed to get the same look back, then export the .cube LUT and the full-size picture (the results row).
import { grader } from "./_d4b.mjs";

export default {
  id: "grade-chaos-lut",
  title: "Color Grader Chaos and LUT",
  tool: "Color Grader",
  kind: "a",
  roles: ["photo.bridge"],
  async run(t) {
    const g = grader(t);
    await t.rec.start();
    t.note(
      "Chaos in Color Grader on a wet night road: Surprise me and Again roll random looks, the seed is always shown; one step is locked and stays through the rerolls; typing a seed brings an exact look back. Then Export: the .cube LUT is written, and the full-size graded picture lands in the Graded folder with its results row (name, Reveal, Open, Save a copy).",
      "Roll the dice for a look, lock the part you like, and export it as a LUT for other editors or as a finished picture."
    );
    await t.open("grade");
    await t.handOff("grade", "photo.bridge");
    await t.waitFor({ css: '[aria-label="Look groups"] button' }, 60000);
    await t.hold(2500);
    await g.wild("Bonkers");
    await t.hold(1000);

    await g.rail("Chaos");
    await t.hold(1000);
    await t.click({ css: "button", text: "Surprise me" });
    await t.hold(2000);
    await t.click({ css: "button", text: "Again" });
    await t.hold(1800);
    await t.click({ css: "button", text: "Again" });
    await t.hold(1800);

    // Lock the first step: it stays through the next rerolls.
    await t.click({ css: 'ul [role="switch"]', nth: 0 });
    await t.hold(1200);
    await t.click({ css: "button", text: "Again" });
    await t.hold(1800);
    await t.click({ css: "button", text: "Again" });
    await t.hold(1800);
    await t.still("Color Grader chaos locked");

    // A typed seed always makes the same look.
    await t.click({ css: 'input[aria-label="Seed"]' });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "4242");
    await t.key("Enter", { chip: false });
    await t.hold(2800);
    await g.close();

    // Export the LUT, then the picture.
    await g.rail("Export");
    await t.hold(1000);
    await t.click({ css: "button", text: "Export .cube" });
    await t.hold(2500);
    await t.still("Color Grader LUT saved");
    await t.click({ css: "button", textRe: "^Export [0-9]+ file" });
    await t.waitJob({ compress: true, timeoutMs: 20 * 60000 });
    await t.hold(2500);
    await t.still("Color Grader chaos export");
    await t.rec.stop();
    await t.reset();
  },
};
