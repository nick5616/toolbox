// 59 Paint+ Lab: three algorithmic tools (Flow field, Reaction-diffusion, Growth) with their predictability
// badges and origin cards, each used on a colour-wash canvas; then Dissolve with its Generations strip when the model is there.
import { at } from "./_d2a.mjs";
import { bigCanvas } from "./_d4b.mjs";

export default {
  id: "paint-lab",
  title: "Paint+ Lab",
  tool: "Paint+",
  kind: "a",
  roles: [],
  async run(t) {
    await t.rec.start();
    t.note(
      "Paint+'s Lab on a canvas washed with colour: Flow field (seeded), Reaction-diffusion (exact) and Growth (seeded). Each device shows its predictability badge, and its About card says where the idea comes from; then one stroke of each does its thing. Finally Dissolve, a perception tool that uses a local model, with the Generations strip of its passes.",
      "Brushes that grow, flow and sort. Every Lab tool says how predictable it is and where the idea comes from."
    );
    await t.open("paint");
    await t.click({ text: "Screen 16:9" });
    await t.waitFor({ css: '[aria-label="Brush library"]' }, 30000);
    await t.hold(1000);
    const c = await bigCanvas(t);
    const P = (fx, fy) => ({ x: Math.round(c.x + fx * c.w), y: Math.round(c.y + fy * c.h) });
    const wave = (fy, amp, phase, x0 = 0.06, x1 = 0.94, n = 24) =>
      Array.from({ length: n + 1 }, (_, i) => {
        const f = i / n;
        return P(x0 + (x1 - x0) * f, fy + amp * Math.sin(f * Math.PI * 2 + phase));
      });
    const closePanel = async () => {
      await t.click({ css: '[aria-label="Close"], button[aria-label*="lose"]' });
      await t.hold(400);
    };

    // A colourful wash for the tools to work on (a soft wide brush, five colours).
    await t.click({ css: '[aria-label="Brush library"]' });
    await t.hold(500);
    await t.click({ css: '[aria-label="Brushes"] [role="listitem"] button', text: "Marker", exact: true });
    await closePanel();
    // (a thicker brush for the Lab tools to chew on)
    const sz = await t.eval(`(()=>{const e=document.querySelector('[data-testid="size-slider"]');if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height*0.28}})()`);
    if (sz) await t.click(await at(t, sz.x, sz.y));
    await t.hold(400);

    const cols = ["#ff3d7f", "#ffd23a", "#3a6bff"];
    for (let i = 0; i < cols.length; i++) {
      await t.click({ css: '[aria-label="Colour"]' });
      await t.hold(300);
      await t.click({ css: 'input[aria-label="Hex colour"]' });
      await t.key("Mod+A", { chip: false });
      await t.type(null, cols[i]);
      await t.key("Enter", { chip: false });
      await t.hold(200);
      await closePanel();
      await t.stroke(wave(0.16 + i * 0.3, 0.04, i * 1.7), { stepPx: 24, delay: 3 });
    }
    await t.hold(600);
    // The Lab panel: every device with its badge.
    const openLab = async () => {
      if (!(await t.exists({ css: '[data-testid="lab-panel"]' }))) await t.click({ css: 'button[aria-label="Lab"]' });
      await t.hold(900);
    };
    await openLab();
    await t.hold(800);
    const about = async (label) => {
      await t.click({ css: `[aria-label="About ${label}"]` });
      await t.hold(2000);
      await t.click({ css: `[aria-label="About ${label}"]` });
      await t.hold(400);
    };
    const use = async (id) => {
      await t.click({ css: `[data-testid="device-${id}"] header button:nth-of-type(2)` });
      await t.hold(600);
    };
    const shut = async () => {
      await t.click({ css: '[aria-label="Close Lab"], button[aria-label*="lose"]' });
      await t.hold(500);
    };
    const reopen = openLab;

    // Flow field.
    await about("Flow field");
    await use("flow-field");
    await shut();
    await t.stroke([P(0.1, 0.5), P(0.3, 0.46), P(0.5, 0.52), P(0.7, 0.46), P(0.9, 0.5)], { stepPx: 20, delay: 6 });
    await t.hold(1500);

    // Reaction-diffusion.
    await reopen();
    await about("Reaction-diffusion");
    await use("reaction-diffusion");
    await shut();
    await t.stroke([P(0.12, 0.7), P(0.4, 0.66), P(0.7, 0.72), P(0.9, 0.68)], { stepPx: 20, delay: 6 });
    await t.hold(3500);

    // Growth.
    await reopen();
    await about("Growth");
    await use("growth");
    await shut();
    await t.stroke([P(0.1, 0.92), P(0.3, 0.9), P(0.5, 0.92), P(0.7, 0.9), P(0.9, 0.92)], { stepPx: 20, delay: 6 });
    await t.hold(2500);
    await t.still("Paint+ Lab");

    // Dissolve (needs the local model): masked area dissolves in generations.
    await reopen();
    const ready = await t.exists({ css: '[data-testid="device-dissolve"]:not([data-disabled])' });
    if (ready) {
      await about("Dissolve");
      await use("dissolve");
      await shut();
      await t.stroke([P(0.35, 0.3), P(0.5, 0.36), P(0.65, 0.3), P(0.62, 0.5), P(0.5, 0.56), P(0.38, 0.5)], { stepPx: 20, delay: 6 });
      await t.hold(1500);
      await t.rec.pause();
      await t.waitFor({ css: '[data-testid="generations"]' }, 300000).catch(() => {});
      await t.hold(4000);
      await t.rec.resume();
      await t.hold(2500);
      await t.still("Paint+ Lab dissolve");
    } else {
      await t.hold(1500);
    }
    await t.rec.stop();
    await t.reset();
  },
};
