// Helpers shared by the D4b scenes (54-59, 68, 69): Color Grader, Paint+ and Photo Composer. Not a scene.

/** The Color Grader's small verbs. */
export function grader(t) {
  const g = {
    wild: (name) => t.click({ css: '[aria-label="Wildness stops"] button', text: name, exact: true }),
    group: (name) => t.click({ css: '[aria-label="Look groups"] button', text: name, exact: true }),
    /** Opens a rail panel (Look, Vibe, Chaos, ...) unless its drawer is already open (it is remembered between runs). */
    async rail(name, title = name) {
      if (await t.exists({ css: `aside[role="dialog"][aria-label=${JSON.stringify(title)}]` })) return;
      await t.click({ css: `button[aria-label=${JSON.stringify(title)}]` });
    },
    /** Applies a gallery look: scrolls its card into view first. */
    async look(name, hold = 2200) {
      await t.eval(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()===${JSON.stringify(name)}&&x.getBoundingClientRect().y>700);if(b)b.scrollIntoView({inline:"center",block:"nearest"})})()`);
      await t.hold(300);
      await t.click({ css: "button", text: name, exact: true });
      await t.hold(hold);
    },
    async close() {
      if (await t.exists({ css: '[aria-label="Close"]' })) await t.click({ css: '[aria-label="Close"]' });
      await t.hold(400);
    },
    async compare(ms) {
      await t.key("\\", { chip: false });
      await t.hold(ms);
    },
    /** Opens Regions, then waits (recording paused) while the region maps are being made. */
    async maps(max = 300) {
      await g.rail("Regions");
      await t.hold(1200);
      await t.rec.pause();
      for (let i = 0; i < max && ((await t.exists({ text: "Making the" })) || (await t.exists({ text: "Preparing" }))); i++) await t.hold(1000);
      await t.hold(1500);
      await t.rec.resume();
    },
  };
  return g;
}

/** The rect of the biggest canvas on the page: {x, y, w, h}. */
export async function bigCanvas(t) {
  return t.eval(`(()=>{let b=null,a=0;for(const c of document.querySelectorAll("canvas")){const r=c.getBoundingClientRect();if(r.width*r.height>a){a=r.width*r.height;b={x:r.x,y:r.y,w:r.width,h:r.height}}}return b})()`);
}
