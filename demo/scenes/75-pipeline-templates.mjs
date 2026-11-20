// 75 Pipeline templates: the gallery (Practical, Just cool), the Paper to Word template opened as a graph with its step
// editor, then run on a picture of a drum chart (text recognition, then a Word document).
import { removePipelinesNamed } from "./_d4c.mjs";

const NAME = "Paper to Word";
const GALLERY = { css: '[role="dialog"][aria-modal="true"]' };

export default {
  id: "pipeline-templates",
  title: "Pipeline templates",
  tool: "Pipelines",
  kind: "a",
  roles: ["image.drumchart"],
  async run(t) {
    await removePipelinesNamed(t, NAME); // untimed: leftovers from an earlier take

    await t.rec.start();
    t.note("The template gallery: Practical pipelines for real jobs, and Just cool ones for fun.", "Start from a ready-made pipeline instead of a blank page.");
    await t.click({ text: "Pipelines" });
    await t.hold(1200);
    await t.click({ css: '[aria-label="Pipelines"]' });
    await t.hold(700);
    await t.click({ css: '[role="menuitem"], [role="option"], button', text: "New pipeline…" });
    await t.waitFor(GALLERY);
    await t.hold(2000);
    await t.scroll(GALLERY, 700, 2200);
    await t.hold(800);
    await t.scroll(GALLERY, 1400, 2600);
    await t.hold(1200);
    await t.scroll(GALLERY, -3000, 2200);
    await t.hold(800);

    t.note("Paper to Word: read the text from photos or scans, save it as a Word document.", "Pick one: this reads a picture of paper and writes it into a Word document.");
    await t.click({ css: `button[aria-label="${NAME}"]` });
    await t.waitFor({ css: '[aria-label="Pipeline graph. Drag a tool in from the store, wire output ports to steps, Delete removes the selection."], [aria-label$=" node"]' });
    await t.hold(2200);

    t.note("The graph shows each step; a click on a step opens every setting it has.", "Every step is a normal tool, with all its settings, and you can change any of them.");
    const nodes = await t.eval(`[...document.querySelectorAll('[data-node-id]')].map((e) => e.getAttribute("aria-label")).join("|")`);
    const second = String(nodes).split("|").filter((n) => n && n !== "Input node")[0];
    if (second) {
      await t.click({ css: `[aria-label="${second}"] [data-param-row]`, nth: 0 });
      await t.hold(2600);
      await t.key("Escape", { chip: false });
    }
    await t.hold(800);

    t.note("Run it on the drum chart picture from the Library.", "Run it on any picture from the Library.");
    await t.click({ css: "button", textRe: "^Run…" });
    await t.hold(900);
    await t.click({ css: "button", text: "From Library" });
    await t.hold(1000);
    await t.pickFromLibrary("image.drumchart");
    await t.hold(700);
    await t.click({ css: "button", text: "Start" });
    await t.hold(2500);
    await t.still("Pipeline templates running");
    await t.waitJob({ compress: true, timeoutMs: 15 * 60000 });
    await t.hold(3000);
    await t.still("Pipeline templates");
    await t.rec.stop();

    await removePipelinesNamed(t, NAME);
    await t.reset();
  },
};
