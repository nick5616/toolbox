// B-roll "Bonkers montage": 12 Color Grader looks applied to photos and B-roll clips, exported through Color Grader
// (GradeService.Enqueue), then assembled 2 s each into one 1080p video with FFmpeg. No screen recording: the clip is the montage.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findFfmpeg } from "../capture/record.mjs";
import { defaultPaths } from "../capture/app.mjs";

const GRADE = "toolbox/modules/grade.Service";
// [look, role of the file it is applied to, needs a picture (depth looks)]
const SHOTS = [
  ["Aerochrome", "photo.rain"],
  ["Thermal", "photo.bridge"],
  ["Inferno by Depth", "photo.skyline"],
  ["Depth Rainbow", "photo.ferris"],
  ["Acid Bath", "video.broll.0"],
  ["Oil Slick", "photo.park"],
  ["Neon Noir", "photo.painting"],
  ["Vaporwave Mall", "video.broll.1"],
  ["X-Ray", "photo.flowers"],
  ["Toxic", "video.broll.2"],
  ["Pop Art", "photo.dessert"],
  ["Solar Flare", "video.broll.3"],
];

export default {
  id: "broll-montage",
  title: "Bonkers montage",
  tool: "Color Grader",
  kind: "b",
  roles: ["photo.rain", "photo.bridge", "photo.skyline", "photo.ferris", "photo.park", "photo.painting", "photo.flowers", "photo.dessert", "video.broll"],
  async run(t) {
    t.note("Twelve Bonkers looks from Color Grader on photos and B-roll clips, two seconds each, assembled into one video.", "");
    const pathOf = (r) => {
      const m = /^video\.broll\.(\d)$/.exec(r);
      return m ? t.roles("video.broll")[Number(m[1])] : t.role(r);
    };
    await t.open("grade");
    await t.handOff("grade", "photo.rain");
    await t.waitFor({ css: '[aria-label="Look groups"] button' }, 60000);
    await t.click({ css: '[aria-label="Look groups"] button', text: "Bonkers", exact: true });
    await t.hold(1000);

    // 1. Save each look to "Mine" through the UI so its recipe can be read back from the service.
    const names = [];
    const jobsOut = [];
    try {
    for (const [look] of SHOTS) {
      // The gallery scrolls sideways and the Export panel covers its right end: bring the tile to the middle first.
      await t.eval(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()===${JSON.stringify(look)}&&x.getBoundingClientRect().y>880);if(b)b.scrollIntoView({inline:"center",block:"nearest"})})()`);
      await t.hold(300);
      await t.click({ css: "button", text: look, exact: true });
      await t.hold(900);
      if (!(await t.exists({ css: "button", text: "Save look" }))) {
        await t.click({ text: "Export", exact: true });
        await t.hold(700);
      }
      await t.click({ css: "button", text: "Save look" });
      await t.hold(900);
      names.push(look);
    }
    const mine = (await t.svc(GRADE, "Looks")) ?? [];
    // (Looks() is newest first, so a look saved earlier under the same name never wins)
      // 2. Export every shot through the Color Grader service, one file per look at full Wildness.
      for (const [look, role] of SHOTS) {
        const recipe = mine.find((r) => r.name === look);
        if (!recipe) throw new Error(`look "${look}" was not saved`);
        const file = pathOf(role);
        const jobs = await t.svc(GRADE, "Enqueue", [file], { recipe, wild: 1, format: "same", beat: { on: false, song: "" } });
        jobsOut.push({ look, role, id: jobs[0].id });
      }
      await t.waitJob({ timeoutMs: 40 * 60000 });
    } finally {
      for (const n of names) await t.svc(GRADE, "DeleteLook", n).catch(() => {});
    }
    const all = await t.jobs();
    const files = jobsOut.map((j) => {
      const job = all.find((x) => x.id === j.id);
      const out = job?.outputs?.[0]?.path;
      if (!out) throw new Error(`no output for ${j.look}`);
      return { ...j, out };
    });

    // 3. Assemble 2 s each at 1080p.
    const defaults = defaultPaths();
    const ffmpeg = findFfmpeg(defaults.toolsDir);
    const rel = path.join("B-roll", "Bonkers montage.mp4");
    const dest = path.join(t.outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    const filters = [];
    files.forEach((f, i) => {
      const isVideo = /\.mp4$/i.test(f.out);
      if (isVideo) args.push("-t", "2", "-i", f.out);
      else args.push("-loop", "1", "-framerate", "30", "-t", "2", "-i", f.out);
      filters.push(`[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p[v${i}]`);
    });
    filters.push(files.map((_, i) => `[v${i}]`).join("") + `concat=n=${files.length}:v=1:a=0[out]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", dest);
    const r = spawnSync(ffmpeg, args, { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr ?? "").slice(-400)}`);
    t.registerClip(rel, files.length * 2);
    await t.reset();
  },
};
