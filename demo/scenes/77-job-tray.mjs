// 77 Job tray: six conversions queued at once; the tray shows the running and waiting ones, one is cancelled,
// another's log is opened, and the rest finish.
const TRAY = { css: '[aria-label="Job tray"]' };

export default {
  id: "job-tray",
  title: "Job tray",
  tool: "Job tray",
  kind: "a",
  roles: ["video.broll"],
  async run(t) {
    const clips = t.roles("video.broll");
    await t.openLibrary();
    await t.hold(500);

    await t.rec.start();
    t.note("Six videos queued for conversion at once; the tray at the bottom counts what is running and waiting.", "Queue as much as you like: jobs run in the background, a few at a time.");
    await t.hold(600);
    await t.svc("toolbox/modules/converter.Service", "Enqueue", clips, { preset: "webm-vp9", maxHeight: "keep", keepMetadata: true });
    await t.hold(2200);

    t.note("Open the job tray: running jobs show their progress, queued ones wait their turn.", "Open the tray to see every job and how far along it is.");
    await t.key("Mod+J");
    await t.waitFor({ css: '[aria-label="Cancel"]' });
    await t.hold(3200);

    t.note("Cancel one job: it stops and its partly made file is cleaned up.", "Changed your mind? Cancel a single job without touching the others.");
    await t.click({ css: '[aria-label="Job tray"] [aria-label="Cancel"]', nth: 2 });
    await t.hold(2200);

    t.note("The log shows the tool's own output, useful when something goes wrong.", "Every job keeps a log you can read.");
    await t.click({ css: '[aria-label="Show log"]', nth: 0 });
    await t.waitFor({ css: '[role="log"]' });
    await t.hold(3500);
    await t.click({ css: '[aria-label="Hide log"]' });
    await t.hold(800);

    await t.waitJob({ compress: true, allowFail: true, timeoutMs: 20 * 60000 });
    await t.hold(1800);
    t.note("When they finish, each job offers Reveal to show its file.", "Finished jobs are one click from their files.");
    await t.hover({ css: '[aria-label="Job tray"] [aria-label^="Show in"], [aria-label="Job tray"] [aria-label^="Reveal"], [aria-label="Job tray"] [aria-label^="Open folder"]' }, 1800).catch(() => {});
    await t.still("Job tray");
    await t.key("Mod+J");
    await t.hold(900);
    await t.rec.stop();
  },
};
