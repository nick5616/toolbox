// B-roll: the pipeline graph running ("Song to everything" on a short song); the cells light up one by one.
export default {
  id: "broll-pipeline",
  title: "Pipeline running",
  tool: "Pipelines",
  kind: "b",
  roles: ["song.short.tickle"],
  async run(t) {
    await t.click({ text: "Pipelines" });
    await t.hold(800);
    if (await t.exists({ css: "button", text: "Edit", exact: true })) await t.click({ css: "button", text: "Edit", exact: true });
    await t.hold(600);
    await t.click({ css: '[aria-label="Pipelines"]' });
    if (await t.exists({ text: "Song to everything" })) {
      await t.click({ text: "Song to everything" });
    } else {
      await t.click({ text: "New pipeline" });
      await t.hold(1200);
      for (let i = 0; i < 14 && !(await t.exists({ text: "Song to everything", exact: true })); i++) await t.scroll({ css: '[role="dialog"]' }, 500, 500);
      await t.hold(600);
      await t.click({ text: "Song to everything", exact: true });
    }
    await t.hold(1500);
    if (await t.exists({ text: "Pick a design" })) {
      await t.click({ text: "Pick a design" });
      await t.hold(400);
      await t.key("Delete", { chip: false });
      await t.hold(800);
    }
    await t.click({ css: "button", textRe: "^Run…" });
    await t.hold(600);
    await t.click({ css: "button", text: "From Library" });
    await t.hold(900);
    await t.type('[role="dialog"] input', "tickle");
    await t.hold(800);
    await t.click({ text: "tickle hehe" });
    await t.click({ css: "button", textRe: "^Add( [0-9]+)?$" });
    await t.hold(600);
    await t.rec.start({ name: "Pipeline running" });
    t.note("The Song to everything pipeline running: the graph lights up cell by cell as each step finishes.", "");
    await t.click({ css: "button", text: "Start" });
    await t.hold(3000);
    await t.waitJob({ compress: true, timeoutMs: 30 * 60000, allowFail: true });
    await t.hold(2500);
    await t.rec.stop();
    await t.reset();
  },
};
