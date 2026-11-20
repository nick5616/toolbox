// Helpers shared by scenes 47-53, 66 and 67 (not a scene: the loader only takes NN-*.mjs).
import fs from "node:fs";
import path from "node:path";
import { rectOf, at } from "./_d2a.mjs";

/**
 * Sets a native range slider (the kit's Slider) by clicking `frac` (0..1) of the way along it:
 * the cursor goes there and the browser sets the value from the click position.
 */
export async function setSlider(t, label, frac) {
  const css = `input[aria-label=${JSON.stringify(label)}]`;
  const r = await rectOf(t, css);
  if (!r) throw new Error(`setSlider: no slider "${label}"`);
  // the thumb has a width: keep to the middle 96% so the click lands on the track
  await t.click(await at(t, r.left + 6 + (r.w - 12) * frac, r.y, "__demo_slider"));
  await t.hold(250);
}

/**
 * A target at the centre of the `nth` element matching `css`, for parts the harness would resolve to an interactive
 * ancestor (SVG handles inside a clip, trim handles): the real mouse goes to the element's own centre.
 */
export async function pointOf(t, css, nth = 0, id = "__demo_el") {
  const r = await t.eval(`(()=>{const e=document.querySelectorAll(${JSON.stringify(css)})[${nth}];if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
  if (!r) throw new Error(`pointOf: nothing matches ${css} [${nth}]`);
  return at(t, r.x, r.y, id);
}

/** The value of a range input by aria-label (string), or null. */
export async function sliderValue(t, label) {
  return t.eval(`(()=>{const s=document.querySelector('input[aria-label=${JSON.stringify(label)}]');return s?s.value:null})()`);
}

/**
 * A target at the trim handle of a clip (`edge` "start" | "end"). The harness resolves a plain div to its closest
 * interactive ancestor (the clip itself), so the handle is reached through a point marker at its centre.
 */
export async function trimHandle(t, clipId, edge = "end", id = "__trim_pt") {
  const css = `[data-clip-id=${JSON.stringify(clipId)}] [data-trim="${edge}"]`;
  const r = await rectOf(t, css);
  if (!r) throw new Error(`trimHandle: no ${edge} handle on clip ${clipId}`);
  return at(t, r.x, r.y, id);
}

/** Seconds of playhead movement with Shift+Arrow (one second each). */
export async function playheadForward(t, seconds) {
  for (let i = 0; i < seconds; i++) await t.key("Shift+ArrowRight", { chip: false });
  await t.hold(300);
}

/**
 * Waits (untimed) until no timeline clip is still preparing. A clip can stay hatched after its prepare job finished
 * (the page missed the update): when no job is active for a few seconds the project is closed and opened again,
 * which reads the sources afresh.
 */
export async function ensurePrepared(t, { timeoutMs = 10 * 60000, idleMs = 8000 } = {}) {
  const busy = () => t.eval(`document.querySelectorAll('[class*="_clip_"][class*="_preparing_"]').length`);
  const end = Date.now() + timeoutMs;
  let lastActive = Date.now();
  let reopened = 0;
  while ((await busy()) > 0) {
    if (Date.now() > end) throw new Error("ensurePrepared: timed out");
    const active = (await t.svc("toolbox/api.JobsService", "List", { moduleId: "", statuses: ["queued", "running"], limit: 60, pipelineRunId: "" })) ?? [];
    if (active.some((j) => !j.quiet)) lastActive = Date.now();
    else if (Date.now() - lastActive > idleMs && reopened < 3) {
      const name = await t.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Videos');const i=b&&b.nextElementSibling;return i&&i.value?i.value:''})()`);
      if (name) {
        await t.click({ css: "button", text: "Videos", exact: true });
        await t.hold(1200);
        await t.click({ text: name, exact: true });
        await t.hold(2500);
        await t.click({ css: "button", text: "Fit", exact: true });
      }
      reopened++;
      lastActive = Date.now();
    }
    await t.hold(1000);
  }
  await t.hold(1500);
}

/** True when the page shows an error toast or banner (the scene must not film one). */
export async function errorOnScreen(t) {
  return t.eval(`(()=>{const e=[...document.querySelectorAll('[role="alert"], [data-tone="danger"]')].filter(x=>x.getBoundingClientRect().width>0);return e.length?e.map(x=>(x.textContent||'').trim().slice(0,120)).join(' | '):''})()`);
}

/**
 * The Library root folder of the capture/demo workspace, derived from any role's path (roles live directly in it
 * or under Extras/).
 */
export function libraryRoot(t, role = "song.main") {
  const p = t.role(role);
  return path.dirname(p).replace(/[\\/]Extras$/i, "");
}

/** Copies `from` to `<outDir>/<rel>` (creating folders). Returns the destination. */
export function copyIntoOut(t, from, rel) {
  const dest = path.join(t.outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(from, dest);
  return dest;
}

/** A name safe for a file on every OS. */
export const safe = (s) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
