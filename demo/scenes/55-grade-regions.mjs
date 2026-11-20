// 55 Color Grader, smart regions: the subject graded apart from its background (Neon Noir), the subject map,
// heat by distance on the skyline (depth map), then Steal a look: a reference photo's colours matched onto another picture.
import { grader } from "./_d4b.mjs";

export default {
  id: "grade-regions",
  title: "Color Grader regions",
  tool: "Color Grader",
  kind: "a",
  roles: ["photo.tshirt", "photo.skyline", "photo.painting", "photo.park"],
  async run(t) {
    const g = grader(t);
    const dlg = '[role="dialog"]:has([aria-label="Search the Library"])';
    await t.rec.start();
    t.note(
      "Color Grader's smart regions. On the T-shirt photo, Neon Noir grades the subject and the background separately; the Regions panel shows the subject map the app made. On the skyline, Depth Rainbow paints hue by distance and the depth map is viewed. Then Steal a look: the colours of a gallery painting are matched onto a cloudy park photo.",
      "Grade the subject and the background differently, or near and far. Or steal the colours of any reference photo."
    );
    await t.open("grade");
    await t.handOff("grade", "photo.tshirt");
    await t.waitFor({ css: '[aria-label="Look groups"] button' }, 60000);
    await t.hold(1500);
    await g.group("Bonkers");
    await t.hold(600);
    await g.look("Neon Noir", 600);
    await g.maps();
    await t.hold(1200);
    await t.still("Color Grader subject and background");

    // The map behind it.
    await g.rail("Regions");
    await t.hold(1000);
    await t.click({ css: '[data-testid="map-subject"] button', text: "View this map" });
    await t.hold(1600);
    await t.click({ css: '[data-testid="map-subject"] button', textRe: "^Viewing this map" });
    await t.hold(600);
    await g.close();

    // Near and far on the skyline.
    await t.handOff("grade", "photo.skyline");
    await t.hold(1200);
    await g.look("Depth Rainbow", 600);
    await g.maps();
    await t.hold(600);
    await g.rail("Regions");
    await t.hold(800);
    await t.click({ css: '[data-testid="map-depth"] button', text: "View this map" });
    await t.hold(1600);
    await t.click({ css: '[data-testid="map-depth"] button', textRe: "^Viewing this map" });
    await t.hold(800);
    await g.close();
    await t.hold(1200);

    // Steal a look from a reference photo (on a plain Clean look first).
    await t.handOff("grade", "photo.park");
    await t.hold(900);
    await g.group("Film");
    await g.look("Clean", 600);
    await g.rail("Steal", "Steal a look");
    await t.hold(800);
    await t.click({ css: "button", text: "From Library" });
    await t.hold(1000);
    await t.type(`${dlg} [aria-label="Search the Library"]`, "IMG_3935");
    await t.hold(900);
    await t.click({ within: dlg, css: "*", text: "IMG_3935.HEIC", exact: true });
    await t.hold(500);
    await t.click({ within: dlg, css: "button", textRe: "^(use|add)( \\d+)?$" });
    await t.hold(1500);
    await t.still("Color Grader steal a look");
    await g.compare(1500);
    await g.compare(300);
    await t.rec.stop();
    await t.reset();
  },
};
