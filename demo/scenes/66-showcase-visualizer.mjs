// 66 Showcase: real Visualizer exports of every preset (20), ~12 s each at 1080p, on four of the demo songs (five
// presets per song). Each export is a normal Visualizer job; its file is copied into <out>/Showcase/Visualizer/<Preset>.mp4.
// The first three exports are filmed as a short B-roll of the render queue ("Visualizer render queue").
//
// Dev knobs (not for the final run): DEMO_SHOWCASE_LIMIT=<n> renders only the first n presets;
// DEMO_SHOWCASE_ONLY="Nebula,Synthwave" renders just those.
import fs from "node:fs";
import path from "node:path";
import { copyIntoOut, safe } from "./_d4a.mjs";
import { openRow, selectSongRange, waitAnalysis, closeDrawer } from "./_d4a-viz.mjs";

const PRESETS = [
  "Golden Hour", "Neon Highway", "Nebula", "Synthwave", "Spectrum Classic",
  "Radial Pulse", "Silk Waves", "Warp Drive", "Kaleido Bloom", "Ink & Water",
  "Particle Storm", "Aurora Curtains", "Tunnel Run", "Night Terrain", "Oscilloscope Lab",
  "Vortex", "Lyric Stage", "Mood Field", "Clean Captions", "Frame Pulse",
];
// five presets per song; the fraction is where in the song the 12 s window starts
const SONGS = [
  { role: "song.main", start: 60 },
  { role: "song.alt", start: 0.35 },
  { role: "song.short.tickle", start: 0.3 },
  { role: "song.short.intense", start: 0.4 },
];

export default {
  id: "showcase-visualizer",
  title: "Visualizer showcase",
  tool: "Visualizer",
  kind: "b",
  roles: ["song.main", "song.alt", "song.short.tickle", "song.short.intense"],
  async run(t) {
    let names = PRESETS;
    if (process.env.DEMO_SHOWCASE_ONLY) {
      const want = process.env.DEMO_SHOWCASE_ONLY.split(",").map((s) => s.trim().toLowerCase());
      names = PRESETS.filter((n) => want.includes(n.toLowerCase()));
    } else if (process.env.DEMO_SHOWCASE_LIMIT) names = PRESETS.slice(0, Number(process.env.DEMO_SHOWCASE_LIMIT));
    const done = [];
    const failed = [];
    let filmed = 0;
    let filming = false;

    for (let s = 0; s < SONGS.length; s++) {
      const group = names.filter((n) => Math.floor(PRESETS.indexOf(n) / 5) === s);
      if (group.length === 0) continue;
      const song = SONGS[s];
      // untimed: hand the song over, wait for the analysis (cached after the first time), pick 12 s
      if (filming) await t.rec.pause();
      await t.open("visualizer");
      await t.handOff("visualizer", song.role);
      await waitAnalysis(t);
      await selectSongRange(t, song.start, 12);
      await t.reset(); // no drawer left open from the last song
      if (filming) await t.rec.resume();

      for (const name of group) {
        if (!filming && filmed === 0 && done.length === 0) {
          await t.rec.start({ name: "Visualizer render queue" });
          t.note("The Visualizer's render queue: a preset is picked, Export video renders the selected 12 s, and the file is listed with its actions.", "");
          filming = true;
        }
        try {
          await openRow(t, "Presets");
          await t.click({ css: `[aria-label="Designs"] button[aria-label=${JSON.stringify(name)}]` });
          await t.hold(filming ? 1500 : 800);
          await closeDrawer(t);
          await t.click({ css: "button", text: "Export", exact: true });
          await t.hold(filming ? 1000 : 500);
          // the Selection range must be on: a whole-song render would take minutes
          const onSel = await t.eval(`(()=>{const r=[...document.querySelectorAll('[role=dialog] [role=radio]')].find(x=>/^Selection/.test(x.textContent.trim()));return !!r&&r.getAttribute('aria-checked')==='true'})()`);
          if (!onSel) await t.click({ css: '[role="dialog"] [role="radio"]', textRe: "^Selection" });
          t.markJobs();
          await t.click({ css: "button", text: "Export video", exact: true });
          await t.move({ css: "main" });
          const jobs = await t.waitJob({ moduleId: "visualizer", timeoutMs: 30 * 60000, allowFail: true });
          const job = jobs.filter((j) => j.status === "done").pop();
          const file = job?.outputs?.[0]?.path;
          if (!file || !fs.existsSync(file)) throw new Error(`no output for ${name}: ${jobs.map((j) => j.status + " " + (j.error ?? "")).join("; ")}`);
          const dest = copyIntoOut(t, file, path.join("Showcase", "Visualizer", `${safe(name)}.mp4`));
          t.registerClip(path.relative(t.outDir, dest), 12);
          done.push(name);
          if (filming) {
            await t.hold(1800);
            if (++filmed >= 3) {
              await t.rec.stop();
              filming = false;
            }
          }
          await closeDrawer(t);
          await t.hold(300);
        } catch (e) {
          failed.push(`${name}: ${e.message}`);
          console.log(`  showcase: ${name} failed: ${e.message}`);
          await t.reset();
        }
      }
    }
    if (filming) await t.rec.stop();
    console.log(`  showcase: ${done.length} rendered, ${failed.length} failed`);
    if (done.length === 0) throw new Error(`no preset rendered: ${failed.join(" | ")}`);
  },
};
