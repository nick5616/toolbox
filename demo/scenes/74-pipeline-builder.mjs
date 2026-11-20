// 74 Pipeline builder: a blank pipeline becomes "shrink the pictures, then zip them": steps added from the tool store,
// wired in the graph, a setting changed, one setting turned into a question the run asks, then a run on two pictures.
import { pickLibraryFile, removePipelinesNamed } from "./_d4c.mjs";

const NAME = "New pipeline";
const DLG = '[role="dialog"]';

export default {
  id: "pipeline-builder",
  title: "Pipeline builder",
  tool: "Pipelines",
  kind: "a",
  roles: ["photo.sketch"],
  async run(t) {
    await removePipelinesNamed(t, NAME); // untimed: leftovers from an earlier take

    await t.rec.start();
    t.note("Build a pipeline from nothing: a blank one, two tools from the store, wired in the graph.", "Build your own pipeline by dropping tools on a canvas and wiring them together.");
    await t.click({ text: "Pipelines" });
    await t.hold(1200);
    if (await t.exists({ css: "button", text: "Edit", exact: true })) await t.click({ css: "button", text: "Edit", exact: true });
    await t.hold(600);
    await t.click({ css: '[aria-label="Pipelines"]' });
    await t.hold(700);
    await t.click({ css: '[role="menuitem"], [role="option"], button', text: "New pipeline…" });
    await t.hold(1500);
    await t.click({ css: "button", text: "Blank pipeline" });
    await t.waitFor({ css: '[aria-label="Downloader node"]' });
    await t.hold(1200);

    // The blank pipeline starts with a Downloader step: swap it for what we want.
    t.note("Add Image Batch and Zip from the tool store, and remove the Downloader the blank pipeline started with.", "Pick a tool from the store to add it, and delete the ones you do not need.");
    await t.type({ css: '[aria-label="Search tools"]' }, "image batch");
    await t.click({ css: '[data-tool-id="imagebatch"]' });
    await t.hold(900);
    await t.click({ css: '[aria-label="Downloader node"] [class*="head"], [aria-label="Downloader node"]', text: "Downloader" });
    await t.hold(500);
    await t.key("Delete", { chip: false });
    await t.hold(900);
    await t.click({ css: '[aria-label="Search tools"]' });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "zip");
    await t.hold(500);
    await t.click({ css: '[data-tool-id="pipelines.zip"]' });
    await t.hold(900);
    await t.click({ css: "button", text: "Tidy up" });
    await t.hold(1200);

    t.note("Wire the files: the run's input goes to Image Batch, Image Batch's pictures go to Zip.", "Drag from one step's output to the next step's input to wire them.");
    await t.drag({ css: '[data-out-port="*"][data-node="input"]' }, { css: '[aria-label="Image Batch node"] [data-in-port]' });
    await t.hold(900);
    await t.drag({ css: '[aria-label="Image Batch node"] [data-out-port="*"]' }, { css: '[aria-label="Zip node"] [data-in-port]' });
    await t.hold(1500);
    await t.click({ css: "button", text: "Tidy up" });
    await t.hold(1200);

    t.note("Turn the long side into a question: the run will ask for it.", "Or turn any setting into a question that is asked every time you run it.");
    await t.hover({ css: '[aria-label="Image Batch node"] [data-param-row]', text: "Long side (px)" }, 500);
    await t.click({ css: '[aria-label="More for Long side (px)"]' });
    await t.hold(800);
    await t.click({ css: '[role="menuitem"]', text: "Ask when the run starts" });
    await t.hold(1800);

    t.note("Run it on a picture from the Library, with the long side set to 1280.", "Start a run, pick your files and answer the question.");
    await t.click({ css: "button", textRe: "^Run…" });
    await t.hold(900);
    await t.click({ within: DLG, css: "input" });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "1280");
    await t.hold(600);
    await t.click({ css: "button", text: "From Library" });
    await t.hold(1000);
    await pickLibraryFile(t, "photo.sketch");
    await t.hold(600);
    await t.click({ css: "button", textRe: "^Start( with \\d+ files?)?$" });
    await t.hold(2500);
    await t.still("Pipeline builder running");
    await t.waitJob({ compress: true, timeoutMs: 10 * 60000 });
    await t.hold(2200);
    await t.still("Pipeline builder");
    await t.rec.stop();

    await removePipelinesNamed(t, NAME);
    await t.reset();
  },
};
