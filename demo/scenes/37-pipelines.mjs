// 37 Pipelines: the "Song to everything" template runs on a short song; the cells light up as each step finishes.
export default {
  id: "pipelines",
  title: "Pipelines",
  tool: "Pipelines",
  kind: "a",
  roles: ["song.short.tickle"],
  async run(t) {
    await t.rec.start();
    t.note(
      "The Song to everything template: stems, tempo and key, renamed stems, MIDI and a zip. The Visualizer step needs a design, so it is taken out for this run; then Run, pick a song from the Library, and the run view lights the cells up one by one.",
      "Chain tools into a pipeline once, then run it on any song."
    );
    await t.click({ text: "Pipelines" });
    await t.hold(800);
    if (await t.exists({ css: "button", text: "Edit", exact: true })) await t.click({ css: "button", text: "Edit", exact: true });
    await t.hold(600);
    await t.click({ css: '[aria-label="Pipelines"]' });
    await t.hold(500);
    await t.click({ text: "Song to everything" });
    await t.hold(2200);
    // The template's Visualizer step wants a design picked: remove it for this run.
    if (await t.exists({ text: "Pick a design" })) {
      await t.click({ text: "Pick a design" });
      await t.hold(500);
      await t.key("Delete", { chip: false });
      await t.hold(1500);
    }
    await t.click({ css: "button", textRe: "^Run…" });
    await t.hold(800);
    await t.click({ css: "button", text: "From Library" });
    await t.hold(1200);
    await t.type('[role="dialog"] input', "tickle");
    await t.hold(900);
    await t.click({ text: "tickle hehe" });
    await t.hold(500);
    await t.click({ css: "button", textRe: "^Add( [0-9]+)?$" });
    await t.hold(900);
    await t.click({ css: "button", text: "Start" });
    await t.hold(2500);
    await t.still("Pipelines running");
    await t.waitJob({ compress: true, timeoutMs: 30 * 60000, allowFail: true });
    await t.hold(2500);
    await t.still("Pipelines");
    await t.rec.stop();
    await t.reset();
  },
};
