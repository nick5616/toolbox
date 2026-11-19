// 46 Color Grader (the hero scene): the rainy street through the Wildness dial, the gallery, the before/after split,
// depth looks on the skyline, a written Vibe, Chaos with its seed, an export; then Snoop Dog Dancing graded with Acid Bath.
export default {
  id: "grade",
  title: "Color Grader",
  tool: "Color Grader",
  kind: "a",
  roles: ["photo.rain", "photo.skyline", "video.green.snoop"],
  async run(t) {
    const wild = (name) => t.click({ css: '[aria-label="Wildness stops"] button', text: name, exact: true });
    const group = (name) => t.click({ css: '[aria-label="Look groups"] button', text: name, exact: true });
    const look = async (name, hold = 2200) => {
      await t.click({ css: "button", text: name, exact: true });
      await t.hold(hold);
    };
    const close = async () => {
      if (await t.exists({ css: '[aria-label="Close"]' })) await t.click({ css: '[aria-label="Close"]' });
      await t.hold(400);
    };
    const compare = async (ms) => {
      await t.key("\\", { chip: false });
      await t.hold(ms);
    };

    await t.rec.start();
    t.note(
      "The rainy street in Color Grader: the Wildness dial from Tasteful to Bonkers, the look gallery (Film, Bold, Bonkers), Thermal, Neon Noir and Acid Bath, then the before/after split. On the skyline, the depth looks (Depth Rainbow, Inferno by Depth) use a depth map made automatically; a Vibe written in words; Chaos re-rolls with a visible seed; export. Finally Snoop Dog Dancing graded with Acid Bath, in motion.",
      "Grade any photo or video, from a gentle film look to completely unhinged, with a dial instead of a hundred sliders."
    );
    await t.open("grade");
    await t.handOff("grade", "photo.rain");
    await t.waitFor({ css: '[aria-label="Look groups"] button' }, 60000);
    await group("Film");
    await t.hold(2500);

    // The Wildness dial, Tasteful -> Bonkers.
    await wild("Tasteful");
    await t.hold(1800);
    const dial = await t.eval(`(()=>{const s=document.querySelector('input[type="range"][aria-label="Wildness"]');const r=s.getBoundingClientRect();const v=(Number(s.value)-Number(s.min))/(Number(s.max)-Number(s.min));return {y:r.y+r.height/2,x0:r.x+8+(r.width-16)*v,x1:r.right-4}})()`);
    const pts = [];
    for (let i = 0; i <= 8; i++) pts.push({ x: dial.x0 + ((dial.x1 - dial.x0) * i) / 8, y: dial.y });
    await t.stroke(pts, { stepPx: 2, delay: 55 });
    await t.hold(2200);

    // The gallery tabs and a few of the Bonkers looks.
    await group("Film");
    await t.hold(1400);
    await group("Bold");
    await t.hold(1400);
    await group("Bonkers");
    await t.hold(1000);
    await look("Thermal");
    await look("Neon Noir");
    await look("Acid Bath");

    // The before/after split.
    await compare(2600);
    await t.still("Color Grader split");
    await compare(300);

    // Depth looks on the skyline.
    await t.handOff("grade", "photo.skyline");
    await t.hold(3500);
    await look("Depth Rainbow", 3500);
    await look("Inferno by Depth", 3500);

    // A look written in words.
    await t.click({ text: "Vibe", exact: true });
    await t.hold(800);
    await t.click({ css: "textarea" });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "haunted vaporwave mall at 3 am");
    await t.hold(500);
    await t.click({ css: "button", text: "Write a look" });
    await t.waitFor({ css: "button", text: "Write a look" }, 120000);
    await t.hold(8000);
    await t.still("Color Grader vibe");

    // Chaos: the same seed always makes the same look.
    await t.click({ text: "Chaos", exact: true });
    await t.hold(1000);
    await t.click({ css: "button", text: "Surprise me" });
    await t.hold(2500);
    await t.click({ css: "button", text: "Again" });
    await t.hold(2500);
    await t.click({ css: "button", text: "Again" });
    await t.hold(2500);
    await t.still("Color Grader chaos");
    await close();

    // Export the skyline with the current look.
    await t.click({ text: "Export", exact: true });
    await t.hold(1200);
    await t.click({ css: "button", textRe: "^Export [0-9]+ file" });
    await t.waitJob({ compress: true, timeoutMs: 20 * 60000 });
    await t.hold(2000);
    await t.still("Color Grader export");

    // A video graded with Acid Bath, in motion.
    await t.handOff("grade", "video.green.snoop");
    await t.hold(4000);
    await look("Acid Bath", 3500);
    await t.click({ text: "Motion", exact: true });
    await t.hold(2500);
    await t.still("Color Grader motion");
    await close();
    await t.click({ text: "Export", exact: true });
    await t.hold(1200);
    await t.click({ css: "button", textRe: "^Export [0-9]+ file" });
    await t.waitJob({ compress: true, timeoutMs: 30 * 60000 });
    await t.hold(2500);
    await t.still("Color Grader video export");
    await t.rec.stop();
    await t.reset();
  },
};
