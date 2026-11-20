// 30 Redact: find faces and number plates in the rainy street photo, review them, blur them.
// Redact can't preview HEIC, so the untimed setup makes a JPEG copy with the Converter (the review step needs a preview).
import { latestOutputs, openTool, scrubPaths, setValue } from "./_d2b.mjs";

export default {
  id: "redact",
  title: "Redact",
  tool: "Redact",
  kind: "a",
  roles: ["photo.rain"],
  async run(t) {
    await openTool(t, "converter", "Converter");
    await t.handOff("converter", "photo.rain");
    await setValue(t, "select", "jpeg");
    await t.click({ css: "button", textRe: "^Convert (files|\\d+ files?)" });
    await t.waitJob({ moduleId: "converter" });
    const [jpg] = await latestOutputs(t, "converter");

    await openTool(t, "redact", "Redact");
    await scrubPaths(t);
    await t.rec.start();

    t.note("Faces and number plates are found automatically.", "Drop a photo and Toolbox finds the faces and number plates.");
    await t.handOff("redact", jpg);
    await t.hold(1200);
    await t.click({ css: "button", textRe: "^Sensitivity" });
    await t.click({ css: "button", text: "High", exact: true });
    await t.key("Escape", { chip: false });
    await t.hold(500);
    await t.click({ css: "button", textRe: "^Find faces" });
    await t.waitJob({ compress: true, allowFail: true });
    await t.hold(2200);

    t.note("Review each box, then save a blurred copy; the original is untouched.", "Check what it found, then save a copy with those areas blurred.");
    await t.hover({ css: "button", textRe: "^Save redacted" }, 600);
    await t.click({ css: "button", textRe: "^Save redacted" });
    await t.waitJob({ compress: true });
    await t.hold(2500);
    await t.still("Redact");
    await t.rec.stop();
  },
};
