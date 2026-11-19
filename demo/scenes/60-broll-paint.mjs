// B-roll: a 20 s Paint+ time-lapse. A new Full HD canvas, flowing strokes with several brushes (no text on screen but the app).
export default {
  id: "broll-paint",
  title: "Paint timelapse",
  tool: "Paint+",
  kind: "b",
  roles: [],
  async run(t) {
    await t.rec.start({ name: "Paint timelapse" });
    t.note("A 20 second time-lapse of painting in Paint+ with several brushes on a blank canvas.", "");
    await t.open("paint");
    await t.click({ text: "Screen 16:9" });
    await t.waitFor({ css: '[aria-label="Brush library"]' }, 30000);
    await t.hold(800);
    const area = async () => t.eval(`(()=>{let b=null,a=0;for(const c of document.querySelectorAll("canvas")){const r=c.getBoundingClientRect();if(r.width*r.height>a){a=r.width*r.height;b={x:r.x,y:r.y,w:r.width,h:r.height}}}return b})()`);
    const brush = async (name) => {
      await t.click({ css: '[aria-label="Brush library"]' });
      await t.hold(300);
      await t.click({ css: "button", text: name, exact: true });
      await t.click({ css: '[aria-label="Close"], button[aria-label*="lose"]' });
      await t.hold(200);
    };
    const r = await area();
    const wave = (fy, amp, phase, n = 28, x0 = 0.08, x1 = 0.92) =>
      Array.from({ length: n + 1 }, (_, i) => {
        const f = i / n;
        return { x: Math.round(r.x + (x0 + (x1 - x0) * f) * r.w), y: Math.round(r.y + (fy + amp * Math.sin(f * Math.PI * 2 + phase)) * r.h) };
      });
    const plan = [
      ["Brush pen", 0.2, 0.06, 0],
      ["Brush pen", 0.26, 0.05, 1],
      ["Marker", 0.34, 0.07, 2],
      ["Marker", 0.42, 0.06, 0.5],
      ["Charcoal stick", 0.5, 0.08, 1.5],
      ["Charcoal stick", 0.58, 0.06, 3],
      ["Soft round", 0.66, 0.07, 2.2],
      ["Soft round", 0.74, 0.05, 0.8],
      ["Willow charcoal", 0.82, 0.06, 2.9],
      ["Chalk", 0.3, 0.12, 4],
      ["Chalk", 0.62, 0.1, 5],
      ["Brush pen", 0.5, 0.18, 1.1],
    ];
    let last = "";
    for (const [name, fy, amp, ph] of plan) {
      if (name !== last) {
        await brush(name);
        last = name;
      }
      await t.stroke(wave(fy, amp, ph), { stepPx: 9, delay: 6 });
    }
    await t.hold(1200);
    await t.rec.stop();
    await t.reset();
  },
};
