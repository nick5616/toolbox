// 69 Showcase: real Color Grader exports. A B-roll of the looks gallery cycling, then 16 looks (Film, Bold, Bonkers) exported
// through Color Grader on photos and short clips; every result is copied to <out>/Showcase/Color Grader/<look> - <source>.<ext>.
import fs from "node:fs";
import path from "node:path";
import { grader } from "./_d4b.mjs";

const GRADE = "toolbox/modules/grade.Service";
// [look, role (or video.broll.N), tier tab]
const SHOTS = [
  ["Teal & Orange", "photo.skyline", "Film"],
  ["Golden Hour", "photo.park", "Film"],
  ["Noir", "photo.facade", "Film"],
  ["Bleach Bypass", "video.broll.2", "Film"],
  ["Cyberpunk", "photo.rain", "Bold"],
  ["Miami Neon", "photo.bridge", "Bold"],
  ["Riso Duotone", "photo.dessert", "Bold"],
  ["Blockbuster", "video.broll.0", "Bold"],
  ["Aerochrome", "photo.flowers", "Bonkers"],
  ["Thermal", "photo.ferris", "Bonkers"],
  ["Depth Rainbow", "photo.brick", "Bonkers"],
  ["Acid Bath", "video.broll.3", "Bonkers"],
  ["Vaporwave Mall", "photo.painting", "Bonkers"],
  ["Neon Noir", "photo.alley", "Bonkers"],
  ["Solar Flare", "video.broll.5", "Bonkers"],
  ["Dreamcore", "photo.skyline", "Bonkers"],
];

const safe = (s) => s.replace(/[<>:"/\\|?*]/g, "").trim();

export default {
  id: "showcase-grade",
  title: "Showcase: Color Grader",
  tool: "Color Grader",
  kind: "b",
  roles: ["photo.rain", "photo.skyline", "photo.park", "photo.facade", "photo.bridge", "photo.dessert", "photo.flowers", "photo.ferris", "photo.brick", "photo.painting", "photo.alley", "video.broll"],
  async run(t) {
    const g = grader(t);
    t.note("Sixteen Color Grader looks across Film, Bold and Bonkers, exported on demo photos and short clips (files in Showcase/Color Grader), plus a B-roll of the look gallery being clicked through.", "");
    const pathOf = (r) => {
      const m = /^video\.broll\.(\d)$/.exec(r);
      return m ? t.roles("video.broll")[Number(m[1])] : t.role(r);
    };

    // 1. B-roll: the gallery cycling through its three groups.
    await t.rec.start({ name: "Color Grader looks gallery" });
    await t.open("grade");
    await t.handOff("grade", "photo.rain");
    await t.waitFor({ css: '[aria-label="Look groups"] button' }, 60000);
    await t.hold(3500);
    for (const tab of ["Film", "Bold", "Bonkers"]) {
      await g.group(tab);
      await t.hold(900);
      const names = (await t.eval(`[...document.querySelectorAll('[data-testid="look-card"] button span:last-child')].map(s=>s.textContent.trim())`)) ?? [];
      for (const n of names.slice(0, 5)) {
        await g.look(n, 1400);
      }
    }
    await t.rec.stop();

    // 2. Save each look to "Mine" through the UI so its recipe can be read back from the service.
    const saved = [];
    const jobsOut = [];
    try {
      for (const [look, , tab] of SHOTS) {
        await g.group(tab);
        await t.hold(500);
        await g.look(look, 800);
        if (!(await t.exists({ css: "button", text: "Save look" }))) {
          await t.click({ text: "Export", exact: true });
          await t.hold(700);
        }
        await t.click({ css: "button", text: "Save look" });
        await t.hold(700);
        saved.push(look);
      }
      const mine = (await t.svc(GRADE, "Looks")) ?? [];

      // 3. Export every shot through the Color Grader service at full Wildness.
      for (const [look, role] of SHOTS) {
        const recipe = mine.find((r) => r.name === look);
        if (!recipe) throw new Error(`look "${look}" was not saved`);
        const file = pathOf(role);
        const jobs = await t.svc(GRADE, "Enqueue", [file], { recipe, wild: 1, format: "same", beat: { on: false, song: "" } });
        jobsOut.push({ look, role, file, id: jobs[0].id });
      }
      await t.waitJob({ timeoutMs: 60 * 60000 });
    } finally {
      for (const n of saved) await t.svc(GRADE, "DeleteLook", n).catch(() => {});
    }

    // 4. Copy the results into Showcase/Color Grader/.
    const all = await t.jobs();
    const dest = path.join(t.outDir, "Showcase", "Color Grader");
    fs.mkdirSync(dest, { recursive: true });
    let n = 0;
    for (const j of jobsOut) {
      const out = all.find((x) => x.id === j.id)?.outputs?.[0]?.path;
      if (!out || !fs.existsSync(out)) throw new Error(`no output for ${j.look}`);
      const source = path.parse(j.file).name;
      fs.copyFileSync(out, path.join(dest, `${safe(j.look)} - ${safe(source)}${path.extname(out)}`));
      n++;
    }
    t.note(`Exported ${n} graded files to Showcase/Color Grader.`, "");
    await t.reset();
  },
};
