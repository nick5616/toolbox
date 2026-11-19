// 31 Metadata: inspect a Demo copy (location already stripped), then strip the rest into a copy.
export default {
  id: "metadata",
  title: "Metadata",
  tool: "EXIF",
  kind: "a",
  roles: ["photo.rain"],
  async run(t) {
    await t.rec.start();
    t.note(
      "A photo opened in EXIF: camera, lens, exposure. Searching for GPS finds nothing (the Demo copy already has its location stripped); then Remove all writes a clean copy.",
      "See everything a photo says about you, and strip it into a clean copy."
    );
    await t.open("exif");
    await t.handOff("exif", "photo.rain");
    await t.waitFor({ text: "Filter tags" });
    await t.hold(900);
    // The File group shows the folder of the file (the real path): fold it away before anything else.
    await t.click({ css: "button", textRe: "^File\\s*13$" });
    await t.hold(700);
    await t.type('input[placeholder="Filter tags"]', "GPS");
    await t.hold(1600);
    // (With the long tag list the option row sits under the sticky Run button, so it is used while the filter keeps the page short.)
    await t.click({ css: "button", text: "Remove all" });
    await t.hold(700);
    await t.click({ css: "button", textRe: "^Remove all metadata" });
    await t.waitJob({ compress: true });
    await t.hold(1500);
    await t.still("Metadata");
    await t.rec.stop();
    await t.reset();
  },
};
