// 29 Object Eraser: paint over the parked car in the alley photo and erase it.
import { dragStrokes, openTool, scrubPaths, setValue } from "./_d2b.mjs";

export default {
  id: "eraser",
  title: "Object Eraser",
  tool: "Object Eraser",
  kind: "a",
  roles: ["photo.alley"],
  async run(t) {
    await openTool(t, "object-eraser", "Object Eraser");
    await scrubPaths(t);
    await t.rec.start();

    t.note("Brush over what you want gone: the parked car at the end of the alley.", "Paint over anything you want gone, like this parked car.");
    await t.handOff("object-eraser", "photo.alley");
    // The HEIC photo takes a while to convert before it can be painted on: cut that wait.
    await t.hold(1500);
    await t.rec.pause();
    await t.waitFor({ css: "canvas" }, 120000);
    await t.hold(800);
    await t.rec.resume();
    await t.hold(1200);
    await setValue(t, 'input[type="range"]', "90");
    await t.hold(600);
    // The car sits near the middle of the canvas at the fitted zoom: sweep across it.
    await dragStrokes(t, [
      [1030, 512, 1124, 512],
      [1124, 546, 1030, 546],
      [1030, 578, 1124, 578],
    ]);
    await t.hold(900);

    t.note("Erase fills the painted area from its surroundings.", "One click and it fills the gap from what's around it.");
    await t.click({ css: "button", textRe: "^Erase" });
    await t.waitJob({ compress: true, timeoutMs: 30 * 60000 });
    await t.hold(1200);
    // Sweep the before/after handle (it starts mid-picture) so both sides are seen.
    await dragStrokes(t, [
      [1314, 760, 1760, 760],
      [1760, 760, 1180, 760],
    ]);
    await t.hold(1500);

    await t.still("Object Eraser");
    await t.rec.stop();
  },
};
