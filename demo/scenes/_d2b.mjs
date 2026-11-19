// Small helpers shared by the D2b scenes (16-30). Not a scene (the loader only takes NN-*.mjs).

/** Sets a text field / textarea / native select like a paste or a pick would (React sees input + change). */
export async function setValue(t, selector, value) {
  const ok = await t.eval(`(()=>{
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`setValue: ${selector} not found`);
  await t.hold(300);
}

/** Clicks the field (so the cursor visibly goes there) and pastes `value` into it. */
export async function paste(t, selector, value) {
  await t.click(selector);
  await setValue(t, selector, value);
}

/** The visible text of the first element matching `selector` (or ""). */
export async function textOf(t, selector) {
  return (await t.eval(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`)) ?? "";
}

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findFfmpeg } from "../capture/record.mjs";

function ps(cmd, env = {}) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } });
}

/**
 * Runs fn() (which may click a Copy button) and puts the previous clipboard TEXT back afterwards.
 * Returns false (and does not run fn) when the clipboard holds an image we could not restore.
 */
export async function withClipboardRestored(fn) {
  if (process.platform !== "win32") {
    await fn();
    return true;
  }
  const img = ps("if (Get-Clipboard -Format Image) { 'image' } else { 'ok' }");
  if (img.stdout.trim() === "image") return false;
  const prev = ps("Get-Clipboard -Raw");
  const text = prev.status === 0 ? prev.stdout.replace(/\r?\n$/, "") : "";
  try {
    await fn();
  } finally {
    ps("if ($env:TB_PREV) { Set-Clipboard -Value $env:TB_PREV } else { Set-Clipboard -Value $null }", { TB_PREV: text });
  }
  return true;
}

/**
 * Types a question into an open Local Chat (waits for the model to load, off camera), sends it and waits for the
 * answer to finish. The wait is cut out of the clip after the answer has started streaming.
 */
export async function chatAsk(t, question, { loadTimeoutMs = 240000, answerTimeoutMs = 240000 } = {}) {
  const box = 'textarea[aria-label="Message"]';
  const ready = `(()=>{const e=document.querySelector('${box}');return !!e && !e.disabled})()`;
  const t0 = Date.now();
  let paused = false;
  while (!(await t.eval(ready))) {
    if (!paused && Date.now() - t0 > 2500) {
      await t.rec.pause();
      paused = true;
    }
    if (Date.now() - t0 > loadTimeoutMs) throw new Error("chat model did not load");
    await t.hold(800);
  }
  if (paused) await t.rec.resume();
  await t.type(box, question);
  await t.hold(400);
  await t.key("Enter", { chip: false });
  const t1 = Date.now();
  let sawStop = false;
  paused = false;
  for (;;) {
    const stop = await t.exists({ css: "button", text: "Stop", exact: true });
    if (stop) sawStop = true;
    if ((sawStop && !stop) || Date.now() - t1 > answerTimeoutMs) break;
    if (!sawStop && Date.now() - t1 > 15000) break;
    if (sawStop && !paused && Date.now() - t1 > 6000) {
      await t.rec.pause();
      paused = true;
    }
    await t.hold(paused ? 1000 : 300);
  }
  if (paused) await t.rec.resume();
  await t.hold(1200);
}

/** Runs FFmpeg (PATH, else the managed copy) in untimed scene setup. Throws with its stderr on failure. */
export function ffmpeg(args) {
  const exe = findFfmpeg(process.env.TOOLBOX_TOOLS_DIR) ?? "ffmpeg";
  const r = spawnSync(exe, ["-v", "error", "-y", ...args], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${r.stderr}`);
}

/** The Extras folder of the capture Library (where generated demo files live). */
export function extrasDir(t, role) {
  return path.join(path.dirname(t.role(role)), "Extras");
}

/** Joins the six generated B-roll clips into one reel (Extras/B-roll reel.mp4, no re-encode) and returns its path. */
export function makeReel(t) {
  const clips = t.roles("video.broll");
  const dir = extrasDir(t, "video.broll");
  const out = path.join(dir, "B-roll reel.mp4");
  if (fs.existsSync(out)) return out;
  const list = path.join(dir, "_reel.txt");
  fs.writeFileSync(list, clips.map((c) => `file '${c.replace(/\\/g, "/")}'`).join("\n") + "\n");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  fs.rmSync(list, { force: true });
  return out;
}

/** Output file paths of the newest finished job of a module (e.g. to hand a result to the next step). */
export async function latestOutputs(t, moduleId) {
  const jobs = (await t.jobs()).filter((j) => j.moduleId === moduleId && j.status === "done");
  jobs.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  const j = jobs[0];
  if (!j) throw new Error(`no finished ${moduleId} job`);
  const outs = (j.outputs ?? []).map((o) => o.path);
  if (outs.length === 0) throw new Error(`${moduleId} job has no outputs`);
  return outs;
}

/**
 * Some result headings print a raw source path (an app bug: they skip the Demo/ path display). Until that is
 * fixed, this keeps any text node that starts with the capture Library's real folder showing `Demo/Library`
 * instead (and any other `C:\Users\<name>` as `~`). Display only; nothing about the app's state changes.
 */
export async function scrubPaths(t) {
  await t.eval(`(()=>{
    if (window.__scrub) return;
    const BS = String.fromCharCode(92);
    const sep = "[" + BS + BS + "/]";
    const libRe = new RegExp("[A-Za-z]:" + sep + "Users" + sep + ".*?" + sep + "demo-capture" + sep + "Library", "gi");
    const userRe = new RegExp("[A-Za-z]:" + sep + "Users" + sep + "[^" + BS + BS + "/ ]+", "gi");
    const fix = (n) => { const v = n.nodeValue; if (!v || !/[A-Za-z]:/.test(v)) return; const w = v.replace(libRe, "Demo/Library").replace(userRe, "~"); if (w !== v) n.nodeValue = w; };
    const walk = (root) => { const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = it.nextNode())) fix(n); };
    new MutationObserver((ms) => { for (const m of ms) { if (m.type === "characterData") fix(m.target); else m.addedNodes.forEach((a) => (a.nodeType === 3 ? fix(a) : a.nodeType === 1 && walk(a))); } })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
    walk(document.body);
    window.__scrub = true;
  })()`);
}

/** The role file whose name contains `part`. */
export function pick(t, role, part) {
  const f = t.roles(role).find((p) => p.includes(part));
  if (!f) throw new Error(`no ${role} file matching ${part}`);
  return f;
}

/** The first paragraph of the generated article after the intro (about 60 words). */
export const ARTICLE_PARAGRAPH =
  "Almost every song you know is built on a small handful of drum patterns. Learn these ten and you can recognise the engine underneath most pop, rock, funk and electronic music.";
