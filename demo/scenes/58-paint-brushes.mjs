// 58 Paint+ brushes, layers and colour: the brush library (several sets), the colour panel, a new layer with a blend mode
// and opacity, and a small painting made with real mouse strokes on a blank canvas.
import { at, chooseOption } from "./_d2a.mjs";
import { bigCanvas } from "./_d4b.mjs";

export default {
  id: "paint-brushes",
  title: "Paint+ brushes and layers",
  tool: "Paint+",
  kind: "a",
  roles: [],
  async run(t) {
    await t.rec.start();
    t.note(
      "Paint+ on a blank 16:9 canvas: the brush library with its sets, a brush picked from each of a few sets, the colour panel (hue bar and the saturation and brightness square), then the Layers panel: a new layer, its blend mode set to Multiply and its opacity lowered, with soft hills painted on it.",
      "Real brushes, real layers: pick a brush set, mix a colour, add a layer with its own blend mode and opacity, and paint."
    );
    await t.open("paint");
    await t.click({ text: "Screen 16:9" });
    await t.waitFor({ css: '[aria-label="Brush library"]' }, 30000);
    await t.hold(1000);
    const c = await bigCanvas(t);
    const P = (fx, fy) => ({ x: Math.round(c.x + fx * c.w), y: Math.round(c.y + fy * c.h) });
    const line = (pts) => pts.map(([fx, fy]) => P(fx, fy));
    const wave = (fy, amp, phase, x0 = 0.08, x1 = 0.92, n = 26) =>
      Array.from({ length: n + 1 }, (_, i) => {
        const f = i / n;
        return P(x0 + (x1 - x0) * f, fy + amp * Math.sin(f * Math.PI * 2 + phase));
      });
    const closePanel = async () => {
      await t.click({ css: '[aria-label="Close"], button[aria-label*="lose"]' });
      await t.hold(400);
    };
    const bigger = async (frac) => {
      const r = await t.eval(`(()=>{const e=document.querySelector('[data-testid="size-slider"]');if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height*(1-${frac})}})()`);
      if (r) await t.click(await at(t, r.x, r.y));
      await t.hold(400);
    };
    const hexCol = async (hex) => {
      await t.click({ css: '[aria-label="Colour"]' });
      await t.hold(600);
      await t.click({ css: 'input[aria-label="Hex colour"]' });
      await t.key("Mod+A", { chip: false });
      await t.type(null, hex);
      await t.key("Enter", { chip: false });
      await t.hold(500);
      await closePanel();
    };

    // The brush library: a few sets, one brush from each.
    await t.click({ css: '[aria-label="Brush library"]' });
    await t.hold(1200);
    const sets = (await t.eval(`[...document.querySelectorAll('[aria-label="Brush sets"] button')].map(b=>b.textContent.trim())`)) ?? [];
    const pick = sets.filter((s) => s !== "All").slice(0, 2);
    for (const s of pick) {
      await t.click({ css: '[aria-label="Brush sets"] button', text: s, exact: true });
      await t.hold(1000);
    }
    await t.click({ css: '[aria-label="Brush sets"] button', text: "All", exact: true });
    await t.hold(800);
    await t.click({ css: '[aria-label="Brushes"] [role="listitem"] button', text: "Soft round", exact: true });
    await t.hold(600);
    await closePanel();

    // Colour: sky blue from the hue bar and the square, then a sun by hex.
    await t.click({ css: '[aria-label="Colour"]' });
    await t.hold(900);
    const hue = await t.eval(`(()=>{const r=document.querySelector('[aria-label="Hue"]').getBoundingClientRect();return {x:r.left,w:r.width,y:r.top+r.height/2}})()`);
    await t.click(await at(t, hue.x + hue.w * 0.6, hue.y));
    await t.hold(700);
    const sv = await t.eval(`(()=>{const r=document.querySelector('[aria-label="Saturation and brightness"]').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
    await t.click(await at(t, sv.x + sv.w * 0.55, sv.y + sv.h * 0.3));
    await t.hold(900);
    await t.click(await at(t, sv.x + sv.w * 0.85, sv.y + sv.h * 0.2));
    await t.hold(900);
    await closePanel();
    // A wide sky wash with a big soft brush.
    await bigger(0.7);
    for (const fy of [0.1, 0.24, 0.38]) await t.stroke(wave(fy, 0.015, fy * 9), { stepPx: 16, delay: 4 });

    // Layers: a new layer in Multiply at a lower opacity for the hills.
    await t.click({ css: '[aria-label="Layers"]' });
    await t.hold(900);
    await t.click({ css: "button", text: "Layer", exact: true });
    await t.hold(1000);
    await chooseOption(t, "Blend mode", 1, "Multiply");
    await t.hold(700);
    const op = await t.eval(`(()=>{const s=document.querySelector('[data-testid="layers-panel"] input[type="range"][aria-label="Opacity"]');const r=s.getBoundingClientRect();return {y:r.top+r.height/2,x0:r.right-8,x1:r.left+r.width*0.62}})()`);
    await t.stroke(Array.from({ length: 9 }, (_, i) => ({ x: op.x0 + ((op.x1 - op.x0) * i) / 8, y: op.y })), { stepPx: 2, delay: 55 });
    await t.hold(900);
    await t.still("Paint+ layers panel");
    await closePanel();
    await hexCol("#2f6b4f");
    await t.stroke(line([[0.02, 0.7], [0.15, 0.58], [0.3, 0.64], [0.45, 0.54], [0.6, 0.62], [0.78, 0.53], [0.95, 0.61]]), { stepPx: 14, delay: 4 });
    await t.stroke(wave(0.74, 0.02, 1.2, 0.04, 0.96), { stepPx: 16, delay: 4 });
    await t.stroke(wave(0.88, 0.02, 2.4, 0.04, 0.96), { stepPx: 16, delay: 4 });
    await t.hold(800);

    await t.hold(1200);
    await t.still("Paint+ brushes");
    await t.rec.stop();
    await t.reset();
  },
};
