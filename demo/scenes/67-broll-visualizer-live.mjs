// B-roll: the Visualizer playing full size on the main song, switching presets at the phrase changes (a section
// boundary and then every four bars). About 35 s.
import { waitAnalysis, openRow, closeDrawer } from "./_d4a-viz.mjs";
import { at } from "./_d2a.mjs";

/** The preview's clock in seconds (the "0:00.000" readout), or -1. */
const clockSec = (t) =>
  t.eval(`(()=>{const e=[...document.querySelectorAll('input,output,span,div')].find((x)=>x.children.length===0&&/^\\d+:\\d\\d\\.\\d{3}$/.test((x.value||x.textContent||'').trim()));if(!e)return -1;const m=(e.value||e.textContent).trim().match(/(\\d+):(\\d\\d)\\.(\\d{3})/);return Number(m[1])*60+Number(m[2])+Number(m[3])/1000})()`);

export default {
  id: "broll-visualizer-live",
  title: "Visualizer live",
  tool: "Visualizer",
  kind: "b",
  roles: ["song.main"],
  async run(t) {
    await t.open("visualizer");
    await t.handOff("visualizer", "song.main");
    await waitAnalysis(t);

    // park the playhead 11.3 s (four bars at 85 bpm) before the section change at 1:30
    const start = 78.7;
    const dur = await t.eval(`(()=>{const m=document.body.innerText.match(/\\/\\s*(\\d+):(\\d\\d)/);return m?Number(m[1])*60+Number(m[2]):0})()`);
    const rect = await t.eval(`(()=>{const e=[...document.querySelectorAll('[class*="_songMap_"] [class*="_stage_"]')][0];if(!e)return null;const r=e.getBoundingClientRect();return {l:r.left,w:r.width,y:r.top+14}})()`);
    if (!dur || !rect) throw new Error("no song map");
    await t.click(await at(t, rect.l + (start / dur) * rect.w, rect.y));
    await t.hold(800);

    const presets = ["Neon Highway", "Aurora Curtains", "Vortex", "Warp Drive"];
    const switchAt = [0, 90, 101.3, 112.6];
    const pick = async (name) => {
      await openRow(t, "Presets");
      await t.click({ css: `[aria-label="Designs"] button[aria-label=${JSON.stringify(name)}]` });
      await t.hold(350);
      await closeDrawer(t);
    };
    await pick(presets[0]);
    await t.click({ css: 'button[aria-label="Play"]' });
    await t.move({ css: "main" });
    await t.rec.start({ name: "Visualizer live" });
    t.note("The Visualizer plays full size on the song; the preset changes at each phrase.", "");
    let next = 1;
    const end = Date.now() + 70000;
    for (;;) {
      const c = await clockSec(t);
      if (c < 0 || Date.now() > end) break;
      if (next < presets.length && c >= switchAt[next] - 2.2) {
        await pick(presets[next]);
        next++;
      }
      if (c >= 116) break;
      await t.hold(150);
    }
    await t.click({ css: 'button[aria-label="Pause"]' }).catch(() => {});
    await t.rec.stop();
  },
};
