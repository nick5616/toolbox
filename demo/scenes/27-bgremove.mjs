// 27 Background Remover: the T-shirt photo becomes a cut-out; the original/cut-out slider shows the edge.
import { openTool, scrubPaths } from "./_d2b.mjs";

const COMPARE = { css: '[aria-label^="Compare original and result"]' };

export default {
  id: "bgremove",
  title: "Background Remover",
  tool: "Background Remover",
  kind: "a",
  roles: ["photo.tshirt"],
  async run(t) {
    await openTool(t, "bg-remover", "Background Remover");
    await scrubPaths(t);
    await t.waitFor({ css: "button", text: "Add files…" });
    await t.rec.start();

    t.note("A photo in, the subject cut out on a transparent background.", "Drop a photo and the subject is cut out of its background.");
    await t.handOff("bg-remover", "photo.tshirt");
    await t.hold(1100);
    await t.click({ css: "button", textRe: "^Remove background" });
    await t.waitJob({ compress: true });
    await t.hold(1000);

    t.note("Slide between the original and the cut-out.", "Slide between the original and the result to check the edges.");
    await t.drag(COMPARE, { text: "Original", exact: true });
    await t.hold(700);
    await t.drag(COMPARE, { text: "Cutout", exact: true });
    await t.hold(900);
    await t.drag(COMPARE, { text: "Original", exact: true });
    await t.hold(1200);

    await t.still("Background Remover");
    await t.rec.stop();
  },
};
