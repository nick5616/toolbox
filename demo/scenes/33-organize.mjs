// 33 Organizer: photos into folders by date taken, look-alikes set aside (copies only).
export default {
  id: "organize",
  title: "Organizer",
  tool: "Organizer",
  kind: "a",
  roles: ["photo.all"],
  async run(t) {
    await t.rec.start();
    t.note(
      "Fourteen photos grouped by date taken; look-alike detection on; the preview shows the folders before anything is copied.",
      "Sort a messy folder into dated folders and set the near-duplicates aside, without touching the originals."
    );
    await t.open("organize");
    await t.handOff("organize", ...t.roles("photo.all"));
    await t.waitFor({ css: "button", textRe: "^Organize 14 files" });
    await t.hold(900);
    await t.click({ text: "Advanced" });
    await t.hold(500);
    await t.click({ css: "button", text: "Look-alike" });
    await t.hold(900);
    await t.click({ css: '[aria-label="Close"], button[aria-label*="lose"]' });
    await t.hold(500);
    await t.click({ text: "Preview" });
    await t.hold(2500);
    await t.click({ css: "button", textRe: "^Organize 14 files" });
    await t.waitJob({ compress: true });
    await t.hold(1500);
    await t.still("Organizer");
    await t.rec.stop();
    await t.reset();
  },
};
