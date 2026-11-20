// 54 Color Grader, Vibe and Read the picture: a look written from words, then six looks suggested for another photo.
import { grader } from "./_d4b.mjs";

export default {
  id: "grade-vibe",
  title: "Color Grader Vibe",
  tool: "Color Grader",
  kind: "a",
  roles: ["photo.flowers", "photo.dessert"],
  async run(t) {
    const g = grader(t);
    await t.rec.start();
    t.note(
      "Color Grader's Vibe: type 'haunted vaporwave mall at 3 am' and the local chat model writes a look that is applied to the photo; the before/after split shows the change. Then on a second photo, Read the picture: the vision model suggests looks that fit it, and they appear in the gallery under 'For this picture'.",
      "Describe the mood in words and Color Grader writes the look. Or let it read the picture and suggest a look that fits. All on your computer."
    );
    await t.open("grade");
    await t.handOff("grade", "photo.flowers");
    await t.waitFor({ css: '[aria-label="Look groups"] button' }, 60000);
    await t.hold(1800);

    // A look written in words.
    await g.rail("Vibe");
    await t.hold(900);
    await t.click({ css: "textarea" });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "haunted vaporwave mall at 3 am");
    await t.hold(600);
    await t.click({ css: "button", text: "Write a look" });
    await t.hold(1500);
    await t.rec.pause(); // the local model loads and writes: time compressed
    await t.waitFor({ css: '[aria-label="Looks the model wrote"], [role="alert"]' }, 600000);
    await t.rec.resume();
    if (await t.exists({ css: '[role="alert"]', text: "couldn't write" })) throw new Error("the chat model could not write a look");
    await t.hold(1800);
    await t.still("Color Grader vibe written");
    await g.compare(1800);
    await g.compare(300);
    await g.close();

    // Read the picture on a second photo.
    await t.handOff("grade", "photo.dessert");
    await t.hold(1800);
    await g.rail("Read", "Read the picture");
    await t.hold(900);
    await t.click({ within: '[role="dialog"][aria-label="Read the picture"]', css: "button", text: "Read the picture" });
    await t.hold(1500);
    await t.rec.pause();
    await t.waitFor({ css: '[aria-label="Looks for this picture"]' }, 600000);
    await t.rec.resume();
    await t.hold(1800);
    await t.still("Color Grader read the picture");
    await t.click({ css: '[aria-label="Looks for this picture"] li:nth-child(1) button' });
    await t.hold(1800);
    await g.close();
    await t.click({ css: '[aria-label="Look groups"] button', text: "For this picture" });
    await t.hold(1000);
    await t.click({ css: '[data-testid="look-card"] button', nth: 0 });
    await t.hold(1800);
    await g.wild("Bonkers");
    await t.hold(2200);
    await g.compare(1600);
    await g.compare(300);
    await t.still("Color Grader suggestions");
    await t.rec.stop();
    await t.reset();
  },
};
