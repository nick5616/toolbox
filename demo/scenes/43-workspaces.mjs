// 43 Workspaces: the sidebar chip menu, then Settings -> Workspaces with "Hide personal details" on.
export default {
  id: "workspaces",
  title: "Workspaces",
  tool: "Workspaces",
  kind: "a",
  roles: [],
  async run(t) {
    await t.rec.start();
    t.note(
      "The workspace chip in the sidebar shows which workspace is open (Demo); Manage workspaces opens Settings, where each workspace can be switched, renamed or restored, and Hide personal details is on.",
      "Keep your own files and a clean demo side by side: switch workspaces from one chip."
    );
    await t.hold(600);
    await t.click({ css: "button", textRe: "^Demo" });
    await t.hold(2200);
    await t.click({ text: "Manage workspaces" });
    await t.waitFor({ text: "Hide personal details" });
    await t.hold(1500);
    await t.hover({ text: "Hide personal details" }, 2200);
    await t.hover({ css: "button", text: "Restore baseline" }, 1800);
    await t.still("Workspaces");
    await t.rec.stop();
    await t.reset();
  },
};
