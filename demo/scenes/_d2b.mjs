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

/** The role file whose name contains `part`. */
export function pick(t, role, part) {
  const f = t.roles(role).find((p) => p.includes(part));
  if (!f) throw new Error(`no ${role} file matching ${part}`);
  return f;
}

/** The first paragraph of the generated article after the intro (about 60 words). */
export const ARTICLE_PARAGRAPH =
  "Almost every song you know is built on a small handful of drum patterns. Learn these ten and you can recognise the engine underneath most pop, rock, funk and electronic music.";
