// Visualizer helpers shared by scenes 52, 66 and 67 (not a scene: the loader only takes NN-*.mjs).

/**
 * Selects `lenSec` seconds of the song from `startSec` on the Visualizer's Song Map, the way a Shift-drag does (its
 * handlers read plain mouse events with shiftKey). Throws when no selection appears.
 */
export async function selectSongRange(t, startSec, lenSec) {
  const ok = await t.eval(`(()=>{
    const m=document.body.innerText.match(/\\/\\s*(\\d+):(\\d\\d)/);if(!m)return 'no duration';
    const dur=Number(m[1])*60+Number(m[2]);
    const stage=[...document.querySelectorAll('[class*="_songMap_"] [class*="_stage_"]')][0];if(!stage)return 'no song map';
    const r=stage.getBoundingClientRect();
    const x=(s)=>r.left+Math.min(1,s/dur)*r.width;
    const y=r.top+r.height/2;
    const s0=Math.max(0,Math.min(${startSec}<1?${startSec}*dur:${startSec},dur-${lenSec}-1));
    const opts=(cx)=>({bubbles:true,cancelable:true,clientX:cx,clientY:y,shiftKey:true,button:0,buttons:1});
    stage.dispatchEvent(new MouseEvent('mousedown',opts(x(s0))));
    window.dispatchEvent(new MouseEvent('mousemove',opts(x(s0+${lenSec}))));
    window.dispatchEvent(new MouseEvent('mouseup',opts(x(s0+${lenSec}))));
    return 'ok '+dur;})()`);
  if (!String(ok).startsWith("ok")) throw new Error(`selectSongRange: ${ok}`);
  await t.hold(500);
  if (!(await t.exists({ css: "button", text: "Clear selection" }))) throw new Error("selectSongRange: no selection appeared");
}

/** Waits (untimed) for the Visualizer's analysis of the song just handed over; its stage text is "Analysing…". */
export async function waitAnalysis(t, { timeoutMs = 60 * 60000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    await t.hold(3000);
    const busy = (await t.exists({ text: "Analysing…" })) || (await t.exists({ text: "Reading the file" })) || (await t.exists({ text: "Waiting to start" }));
    if (!busy) break;
    if (Date.now() > end) throw new Error("the analysis did not finish");
  }
  // the designer is up when its rail has the Presets row (a cached analysis shows "Loading the analysis…" first)
  await t.waitFor({ css: 'button[aria-haspopup="dialog"]', textRe: "^Presets" }, 20 * 60000);
  await t.hold(2500);
}

/** Closes the open designer drawer: Escape, then the Close button when it is still there. */
export async function closeDrawer(t) {
  await t.key("Escape", { chip: false });
  await t.hold(500);
  if (await t.exists({ css: "button", text: "Close", exact: true })) {
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(300);
  }
}

/** Opens a designer rail row ("Presets", "Look", "Layers", …). */
export async function openRow(t, title) {
  // textRe on the start of the row's text: the other rows' tooltips mention "look" and "presets" too
  await t.click({ css: 'button[aria-haspopup="dialog"]', textRe: `^${title}` });
  await t.hold(900);
}
