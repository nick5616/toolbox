// Helpers shared by scenes 01-15 (not a scene: the loader only takes NN-*.mjs).

/** Waits (untimed) until Smart search has indexed everything it was going to. */
export async function waitIndexed(t, { timeoutMs = 40 * 60000 } = {}) {
  const end = Date.now() + timeoutMs;
  let calm = 0;
  for (;;) {
    const s = await t.svc("toolbox/api.SearchService", "Status");
    if (s && s.installed && s.enabled && s.total > 0 && s.pending === 0 && s.speechPending === 0) {
      if (++calm >= 3) return s;
    } else calm = 0;
    if (Date.now() > end) throw new Error(`Smart search is not done: ${JSON.stringify(s)}`);
    await t.hold(4000);
  }
}

/**
 * A click/drag target at an exact screen point: parks a 2 px invisible marker there and returns its selector.
 * (The real mouse goes to the point; the marker never takes events.)
 */
export async function at(t, x, y, id = "__demo_pt") {
  await t.eval(`(()=>{let e=document.getElementById(${JSON.stringify(id)});if(!e){e=document.createElement('div');e.id=${JSON.stringify(id)};e.style.cssText='position:fixed;width:2px;height:2px;pointer-events:none;z-index:1;';document.body.appendChild(e)}e.style.left=${x - 1}+'px';e.style.top=${y - 1}+'px';return 1})()`);
  return { css: `#${id}` };
}

/** The rect of an element: {x, y, w, h, left, top} (centre x, y). */
export async function rectOf(t, css) {
  return t.eval(`(()=>{const e=document.querySelector(${JSON.stringify(css)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,left:r.left,top:r.top}})()`);
}

/** A point `frac` (0..1) along the first element matching `css`, at its vertical middle. */
export async function alongClip(t, css, frac, id) {
  const r = await rectOf(t, css);
  if (!r) throw new Error(`alongClip: nothing matches ${css}`);
  return at(t, r.left + r.w * frac, r.y, id);
}

/** Every clip on the timeline: {id, label, left, top, w, h, x, y, row}, left to right, top track first. */
export async function clipRects(t) {
  return t.eval(`(()=>{const rows=[...document.querySelectorAll('[data-track-row]')];return [...document.querySelectorAll('[data-clip-id]')].map(e=>{const r=e.getBoundingClientRect();const row=rows.findIndex(x=>x.contains(e));return {id:e.getAttribute('data-clip-id'),label:(e.getAttribute('aria-label')||e.textContent||'').trim(),left:r.left,top:r.top,w:r.width,h:r.height,x:r.left+r.width/2,y:r.top+r.height/2,row}}).sort((a,b)=>a.row-b.row||a.left-b.left)})()`);
}

/** The centre y of the n-th track row (0 = top). */
export async function rowY(t, n) {
  return t.eval(`(()=>{const r=document.querySelectorAll('[data-track-row]')[${n}];if(!r)return null;const b=r.getBoundingClientRect();return b.top+b.height/2})()`);
}

/** The current value of a native <select> by aria-label (they open a popup the screencast can't see). */
export async function selectValue(t, label) {
  return t.eval(`(()=>{const s=document.querySelector('select[aria-label=${JSON.stringify(label)}]');return s?s.options[s.selectedIndex].text:null})()`);
}

/** Changes a native <select> by keys (its popup is invisible to the screencast): click, arrows, Enter; checks the result. */
export async function chooseOption(t, label, steps, expect) {
  await t.click({ css: `select[aria-label=${JSON.stringify(label)}]` });
  const key = steps < 0 ? "ArrowUp" : "ArrowDown";
  for (let i = 0; i < Math.abs(steps); i++) await t.key(key, { chip: false });
  await t.key("Enter", { chip: false });
  await t.hold(300);
  const now = await selectValue(t, label);
  if (expect && !new RegExp(expect, "i").test(now ?? "")) throw new Error(`${label}: wanted ${expect}, got ${now}`);
}

/**
 * Starts a new 16:9 30 fps video in the Video Editor from `paths` (absolute) through the UI, untimed:
 * back to the projects page if a video is open, drop the files, pick the shape, Create, wait for the clips to prepare.
 */
export async function newVideo(t, paths) {
  await t.open("video-studio");
  if (await t.exists({ css: "button", text: "Videos", exact: true })) await t.click({ css: "button", text: "Videos", exact: true });
  await t.handOff("video-studio", ...paths);
  await t.hold(900);
  await t.click({ css: '[role="radio"]', text: "16:9" });
  await t.click({ css: '[role="dialog"] button', text: "Create" });
  await t.hold(2500);
  await t.waitJob({ allowFail: true });
  await t.hold(1000);
}

/** In the Media drawer: "Add from Library", search the file of `role`, pick and confirm (untimed). */
export async function addFromLibrary(t, role, { wait = true } = {}) {
  const files = t.roles(role);
  const dlg = '[role="dialog"]:has([aria-label="Search the Library"])'; // the picker (the Media drawer is a dialog too)
  await t.click({ css: "button", text: "Add from Library" });
  await t.hold(700);
  for (const f of files) {
    const base = f.split(/[\\/]/).pop();
    await t.type(`${dlg} [aria-label="Search the Library"]`, base.replace(/\.[^.]+$/, ""));
    await t.hold(800);
    await t.click({ within: dlg, css: "*", text: base, exact: true });
    await t.hold(300);
  }
  await t.click({ within: dlg, css: "button", textRe: "^(use|add)( \\d+)?$" });
  await t.hold(900);
  if (wait) {
    await t.waitJob({ allowFail: true });
    await t.hold(700);
  }
}
