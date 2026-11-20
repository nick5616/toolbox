// Helpers shared by the D4c scenes (70-79, 90-91). Not a scene (the loader only takes NN-*.mjs).
export { waitIndexed } from "./_d2a.mjs";

/**
 * In an open "From Library" picker (the pipeline Run dialog's): searches for the file of `role`, picks the card by its
 * name (card names are cut with an ellipsis on screen, so match the start) and confirms with Add.
 */
export async function pickLibraryFile(t, role) {
  const file = t.roles(role)[0];
  const stem = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  const dlg = '[role="dialog"]:has([aria-label="Search the Library"])';
  await t.type(`${dlg} [aria-label="Search the Library"]`, stem);
  await t.hold(900);
  await t.click({ within: dlg, text: stem.slice(0, 12) });
  await t.hold(500);
  await t.click({ within: dlg, css: "button", textRe: "^(use|add)( \\d+)?$" });
  await t.hold(900);
}

/** Untimed: waits until every picture and document is indexed (Things and labels need that; speech may still run). */
export async function waitPicturesIndexed(t, { timeoutMs = 40 * 60000 } = {}) {
  const end = Date.now() + timeoutMs;
  let calm = 0;
  for (;;) {
    const s = await t.svc("toolbox/api.SearchService", "Status");
    if (s && s.installed && s.enabled && s.total > 0 && s.pending === 0) {
      if (++calm >= 3) return s;
    } else calm = 0;
    if (Date.now() > end) throw new Error(`Smart search is not done: ${JSON.stringify(s)}`);
    await t.hold(2000);
  }
}

/** The Library search box. */
export const SEARCH_BOX = { css: '[aria-label="Search the library"]' };

/** Empties the Library search box like a person would (click, select all, delete). */
export async function clearSearch(t) {
  await t.click(SEARCH_BOX);
  await t.key("Mod+A", { chip: false });
  await t.key("Backspace", { chip: false });
}

/**
 * After a chat prompt was sent (a suggested-prompt chip): waits for the model to load and the answer to finish.
 * Recording is paused (and cut out) while the model loads and once the answer has streamed for a few seconds.
 */
export async function awaitChatAnswer(t, { timeoutMs = 6 * 60000 } = {}) {
  const t0 = Date.now();
  let paused = false;
  let sawStop = false;
  for (;;) {
    const stop = await t.exists({ css: "button", text: "Stop", exact: true });
    if (stop) sawStop = true;
    if (sawStop && !stop) break;
    if (Date.now() - t0 > timeoutMs) throw new Error("the chat never answered");
    if (!paused && Date.now() - t0 > (sawStop ? 6000 : 2500)) {
      await t.rec.pause();
      paused = true;
    }
    await t.hold(paused ? 1000 : 300);
  }
  if (paused) await t.rec.resume();
  await t.hold(1500);
}

/** Untimed: deletes every saved pipeline called `name` (a take of a pipeline scene leaves its own behind). */
export async function removePipelinesNamed(t, name) {
  const list = (await t.svc("toolbox/modules/pipelines.Service", "List")) ?? [];
  for (const e of list) {
    if (e?.pipeline?.name === name) await t.svc("toolbox/modules/pipelines.Service", "Delete", e.pipeline.id);
  }
}

/** Switches the Library's View control (Grid, List, Folders, By tool, Things). */
export async function libraryView(t, name) {
  await t.click({ css: '[aria-label="View"] button', text: name, exact: true });
}

/**
 * Untimed set-up: makes a two-step chain in the Library (a song -> MP3 -> Opus) so one file has both a "Made from"
 * and a "Made into". Returns the files made.
 */
export async function makeChain(t, role = "song.alt") {
  const song = t.role(role);
  await t.svc("toolbox/modules/converter.Service", "Enqueue", [song], { preset: "mp3-320", maxHeight: "keep", keepMetadata: true });
  const a = await t.waitJob({ settle: 300 });
  const mp3 = a.flatMap((j) => j.outputs ?? []).find((o) => /\.mp3$/i.test(o.name));
  if (!mp3) throw new Error("the first conversion made no MP3");
  await t.svc("toolbox/modules/converter.Service", "Enqueue", [mp3.path], { preset: "opus-160", maxHeight: "keep", keepMetadata: true });
  const b = await t.waitJob({ settle: 300 });
  const opus = b.flatMap((j) => j.outputs ?? []).find((o) => /\.opus$/i.test(o.name));
  if (!opus) throw new Error("the second conversion made no Opus file");
  return { mp3, opus };
}
