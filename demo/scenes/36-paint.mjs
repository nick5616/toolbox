// 36 Paint+: the plover drawing opened as a canvas, scripted brush strokes, a Lab tool (Growth) with its origin card.
export default {
  id: "paint",
  title: "Paint+",
  tool: "Paint+",
  kind: "a",
  roles: ["photo.plover"],
  async run(t) {
    await t.rec.start();
    t.note(
      "The plover drawing dropped on Paint+ becomes a canvas; a few real brush strokes, then the Lab: Growth's origin card says where the idea comes from, and one stroke grows branches and leaves.",
      "Paint on your own pictures with real brushes, and let the Lab's tools grow something from every stroke."
    );
    await t.open("paint");
    // Gallery: a dropped picture becomes a new canvas (or reopen the one made before).
    if (await t.exists({ text: "YOUR PAINTINGS" }) && (await t.exists({ text: "IMG_3946" }))) await t.click({ text: "IMG_3946", nth: 0 });
    else await t.handOff("paint", "photo.plover");
    await t.waitFor({ css: '[aria-label="Brush library"]' }, 30000);
    await t.hold(1000);

    // Canvas-relative points (fractions of the picture): the picture is centred in the canvas area, 80 px margin.
    const at = async (pts) => {
      const r = await t.eval(`(()=>{let b=null,a=0;for(const c of document.querySelectorAll("canvas")){const r=c.getBoundingClientRect();if(r.width*r.height>a){a=r.width*r.height;b={x:r.x,y:r.y,w:r.width,h:r.height}}}return b})()`);
      const aspect = 0.75;
      const h = Math.min(r.h - 80, (r.w - 80) / aspect);
      const w = h * aspect;
      const x0 = r.x + (r.w - w) / 2;
      const y0 = r.y + (r.h - h) / 2;
      return pts.map(([fx, fy]) => ({ x: Math.round(x0 + fx * w), y: Math.round(y0 + fy * h) }));
    };

    // Plain strokes with a real brush first: a loose line across the sky and one under the sheet.
    await t.click({ css: '[aria-label="Brush library"]' });
    await t.hold(900);
    await t.click({ css: "button", text: "Brush pen", exact: true });
    await t.hold(600);
    await t.click({ css: '[aria-label="Close"], button[aria-label*="lose"]' });
    await t.hold(500);
    await t.stroke(await at([[0.06, 0.16], [0.2, 0.12], [0.38, 0.1], [0.58, 0.115], [0.78, 0.15], [0.94, 0.12]]));
    await t.stroke(await at([[0.08, 0.84], [0.25, 0.8], [0.45, 0.82], [0.65, 0.79], [0.9, 0.83]]));
    await t.hold(700);

    // The Lab: its panel (Brushes > Lab tab), Growth's origin card, then Growth on the canvas.
    await t.click({ css: '[aria-label="Brush library"]' });
    await t.hold(700);
    await t.click({ css: "button", text: "Lab", exact: true });
    await t.hold(1000);
    await t.click({ css: '[aria-label="About Growth"]' });
    await t.hold(2500);
    await t.key("Escape", { chip: false });
    await t.click({ css: '[aria-label="Close Lab"]' });
    await t.hold(700);
    await t.click({ css: '[aria-label^="Growth: "]' });
    await t.hold(700);
    await t.stroke(await at([[0.12, 0.9], [0.3, 0.88], [0.5, 0.9], [0.7, 0.88]]));
    await t.hold(1200);
    await t.stroke(await at([[0.1, 0.06], [0.3, 0.04], [0.5, 0.06], [0.7, 0.04]]));
    await t.hold(1000);
    await t.still("Paint+");
    await t.rec.stop();
    await t.reset();
  },
};
