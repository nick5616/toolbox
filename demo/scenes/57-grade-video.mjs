// 57 Color Grader on video: a look that moves (Acid Bath's hue cycle), the Motion panel's speed and "On the beat" wave,
// beat sync to a song from the Library, the preview playing, then the export.
import { grader } from "./_d4b.mjs";

export default {
  id: "grade-video",
  title: "Color Grader video",
  tool: "Color Grader",
  kind: "a",
  roles: ["video.broll", "song.short.intense"],
  async run(t) {
    const g = grader(t);
    const clip = t.roles("video.broll")[3]; // the ferris wheel
    await t.rec.start();
    t.note(
      "A video in Color Grader: Acid Bath's hue cycle moves on its own while the preview plays. The Motion panel sets each moving step's speed and wave; one step is switched to 'On the beat' and synced to a song from the Library, so the colours pulse with the music. Then the video is exported with its sound.",
      "Grade video too: looks can move, and pulse on the beat of any song. Preview it live, then export."
    );
    await t.open("grade");
    await t.handOff("grade", clip);
    await t.waitFor({ css: '[aria-label="Look groups"] button' }, 60000);
    await t.rec.pause();
    await t.hold(1500);
    for (let i = 0; i < 90 && (await t.exists({ text: "Preparing" })); i++) await t.hold(1000);
    await t.hold(1500);
    await t.rec.resume();
    await g.group("Bonkers");
    await t.hold(800);
    await g.look("Acid Bath", 1000);
    await t.click({ css: '[aria-label="Playback"] button[aria-label="Play"]' });
    await t.hold(3500);

    // Motion: which steps move, how fast, and sync to the beat.
    await g.rail("Motion");
    await t.hold(1500);
    await t.click({ css: "label", text: "Sync to the beat" });
    await t.hold(1200);
    await t.click({ css: "button", text: "From Library" });
    await t.hold(1200);
    const dlg = '[role="dialog"]:has([aria-label="Search the Library"])';
    await t.type(`${dlg} [aria-label="Search the Library"]`, "MOST INTENSE");
    await t.hold(900);
    await t.click({ within: dlg, css: "*", textRe: "MOST INTENSE.*mp3" });
    await t.hold(500);
    await t.click({ within: dlg, css: "button", textRe: "^(use|add)( \d+)?$" });
    await t.hold(900);
    await t.hold(2500);
    await t.still("Color Grader motion beat sync");
    await g.close();
    await t.hold(3000);
    await t.click({ css: '[aria-label="Playback"] button[aria-label="Pause"]' });
    await t.hold(800);

    // Export the video.
    await g.rail("Export");
    await t.hold(1000);
    await t.click({ css: "button", textRe: "^Export [0-9]+ file" });
    await t.waitJob({ compress: true, timeoutMs: 40 * 60000 });
    await t.hold(2500);
    await t.still("Color Grader video export");
    await t.rec.stop();
    await t.reset();
  },
};
