// The scene API (`t`): what a person does, done through the DevTools protocol.
// See demo/README.md for the full list. Production builds have no dev handles
// (window.__ui), so navigation uses the sidebar / palette DOM, hand-offs are
// synthetic in-app drops (the same thing dragging a Library row onto a tool does),
// and jobs are read through the Wails runtime's own transport.
import { createRequire } from "node:module";
import path from "node:path";
import { MOD, sleep } from "./cdp.mjs";
import { takeStill } from "./record.mjs";
import { otherToolboxProcesses } from "./app.mjs";
import { resolveRole } from "../roles.mjs";

const require = createRequire(import.meta.url);
const cursor = require("./cursor.js"); // pure helpers (moveDuration, ease, pathPoint)

export const HANDLE_MS = 1500;

// --- pure parts (unit tested) ------------------------------------------------

export function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator so takes are repeatable. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Delay before each character: 12-18 characters per second with jitter (ms). */
export function typingDelays(text, rng) {
  const cps = 12 + rng() * 6;
  const base = 1000 / cps;
  return Array.from(text, (ch) => Math.round(base * (0.7 + rng() * 0.6) * (ch === " " ? 1.2 : 1)));
}

const NAMED = {
  enter: ["Enter", "Enter", 13],
  return: ["Enter", "Enter", 13],
  escape: ["Escape", "Escape", 27],
  esc: ["Escape", "Escape", 27],
  tab: ["Tab", "Tab", 9],
  backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46],
  space: [" ", "Space", 32],
  arrowup: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39],
  up: ["ArrowUp", "ArrowUp", 38],
  down: ["ArrowDown", "ArrowDown", 40],
  left: ["ArrowLeft", "ArrowLeft", 37],
  right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
  "/": ["/", "Slash", 191],
  ",": [",", "Comma", 188],
  ".": [".", "Period", 190],
  "-": ["-", "Minus", 189],
  "=": ["=", "Equal", 187],
  "\\": ["\\", "Backslash", 220],
  "[": ["[", "BracketLeft", 219],
  "]": ["]", "BracketRight", 221],
};

/** "Ctrl+Shift+K" / "Mod+K" / "Enter" -> {key, code, vk, modifiers, label, text}. `Mod` is Ctrl (Cmd on macOS). */
export function parseCombo(combo, platform = process.platform) {
  const parts = combo.split("+").map((s) => s.trim()).filter(Boolean);
  const keyPart = parts.pop();
  if (!keyPart) throw new Error(`bad key combo "${combo}"`);
  let modifiers = 0;
  const names = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (k === "mod") {
      modifiers |= platform === "darwin" ? MOD.Meta : MOD.Ctrl;
      names.push(platform === "darwin" ? "Cmd" : "Ctrl");
    } else if (k === "ctrl" || k === "control") {
      modifiers |= MOD.Ctrl;
      names.push("Ctrl");
    } else if (k === "alt" || k === "option") {
      modifiers |= MOD.Alt;
      names.push("Alt");
    } else if (k === "shift") {
      modifiers |= MOD.Shift;
      names.push("Shift");
    } else if (k === "meta" || k === "cmd" || k === "super") {
      modifiers |= MOD.Meta;
      names.push("Cmd");
    } else throw new Error(`unknown modifier "${p}" in "${combo}"`);
  }
  const lower = keyPart.toLowerCase();
  let key;
  let code;
  let vk;
  if (NAMED[lower]) [key, code, vk] = NAMED[lower];
  else if (/^f([1-9]|1[0-2])$/.test(lower)) {
    key = keyPart.toUpperCase();
    code = key;
    vk = 111 + Number(lower.slice(1));
  } else if (/^[a-z]$/.test(lower)) {
    key = modifiers & MOD.Shift ? lower.toUpperCase() : lower;
    code = "Key" + lower.toUpperCase();
    vk = lower.toUpperCase().charCodeAt(0);
  } else if (/^[0-9]$/.test(lower)) {
    key = lower;
    code = "Digit" + lower;
    vk = 48 + Number(lower);
  } else throw new Error(`unknown key "${keyPart}" in "${combo}"`);
  const pretty = key.length === 1 ? key.toUpperCase() : key === " " ? "Space" : key;
  const text = key.length === 1 && !(modifiers & (MOD.Ctrl | MOD.Alt | MOD.Meta)) ? key : key === "Enter" ? "\r" : undefined;
  return { key, code, vk, modifiers, text, label: [...names, pretty].join("+") };
}

/** "3:12" for 192000 ms. */
export function clock(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The text of a "time compressed" note for the shot list. */
export function compressedNote(ms, shownMs = 1000) {
  return ms > 0 ? `${clock(ms)} → ${clock(shownMs)}` : "";
}

/** A clip's file name per kind. */
export function clipFile(scene, name) {
  const nn = String(scene.number).padStart(2, "0");
  const title = safeName(name ?? scene.title);
  if (scene.kind === "b") return path.join("B-roll", `${title}.mp4`);
  return path.join("A-roll", `${nn} ${title}.mp4`);
}

export function safeName(s) {
  return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
}

// --- the scene API -------------------------------------------------------------

/**
 * @param ctx {cdp, recorder|null, roles, libraryDir, outDir, scene: {number,id,title,tool,kind,roles}, appPid, log}
 * Returns {t, state} where state collects clips, stills and notes for the shot list.
 */
export function createActions(ctx) {
  const { cdp, recorder, roles: rolesDoc, libraryDir, outDir, scene } = ctx;
  const log = ctx.log ?? (() => {});
  const rng = seeded(hashSeed(`${scene.number}:${scene.id}`));
  const state = { clips: [], stills: [], notes: [], vo: [], compressedMs: 0, assets: new Set() };
  const record = !!recorder;
  let pos = { x: 1500, y: 900 };
  let recording = false;
  let clipName = null;
  let jobMark = Date.now();
  let placed = false;
  let listing = ctx.listing ?? [];

  const page = (fnCall) => cdp.eval(fnCall);
  const lit = cdp.lit;

  async function find(spec, { wait = 8000, required = true } = {}) {
    const end = Date.now() + wait;
    for (;;) {
      const b = await page(`window.__demo.find(${lit(spec)})`);
      if (b) return b;
      if (Date.now() > end) {
        if (required) throw new Error(`nothing on screen matches ${JSON.stringify(spec)}`);
        return null;
      }
      await sleep(150);
    }
  }

  async function ensureCursor() {
    if (placed) return;
    await page(`window.__demoCursor.place(${pos.x},${pos.y})`);
    placed = true;
  }

  /** Glides the real mouse (and so the overlay) to (x, y). */
  async function glide(x, y, { buttons = 0 } = {}) {
    await ensureCursor();
    const from = pos;
    const to = { x, y };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 2) return;
    const dur = cursor.moveDuration(dist);
    const bow = Math.min(36, dist * 0.06) * (rng() < 0.5 ? -1 : 1);
    const nx = (to.y - from.y) / dist;
    const ny = -(to.x - from.x) / dist;
    const t0 = Date.now();
    for (;;) {
      const k = Math.min(1, (Date.now() - t0) / dur);
      const p = cursor.pathPoint(from, to, k);
      const arc = Math.sin(Math.PI * k) * bow;
      await cdp.mouse("mouseMoved", Math.round(p.x + nx * arc), Math.round(p.y + ny * arc), buttons ? { buttons } : {});
      if (k >= 1) break;
      await sleep(14);
    }
    await cdp.mouse("mouseMoved", Math.round(to.x), Math.round(to.y), buttons ? { buttons } : {});
    pos = to;
  }

  async function pressAt(x, y, { right = false, count = 1 } = {}) {
    const button = right ? "right" : "left";
    for (let i = 1; i <= count; i++) {
      await cdp.mouse("mousePressed", x, y, { button, clickCount: i, buttons: right ? 2 : 1 });
      await sleep(60);
      await cdp.mouse("mouseReleased", x, y, { button, clickCount: i, buttons: 0 });
      if (i < count) await sleep(70);
    }
  }

  function jitter(b) {
    const j = Math.min(b.w, b.h, 40) / 4;
    return { x: b.x + (rng() - 0.5) * 2 * j, y: b.y + (rng() - 0.5) * 2 * j };
  }

  const roleFiles = (name) => {
    const files = resolveRole(rolesDoc, name, libraryDir, listing);
    files.forEach((f) => state.assets.add(path.basename(f)));
    return files;
  };

  const t = {
    // --- recording ---
    rec: {
      /** Starts the clip and holds the 1.5 s start handle (pass {handle:false} to hold it yourself with t.handles()). */
      async start({ name, handle = true } = {}) {
        clipName = name ?? null;
        if (record) {
          await recorder.start();
          recording = true;
        }
        await ensureCursor();
        if (handle) await t.handles();
      },
      /** Holds the end handle, then stops and encodes. Returns {file, duration} (null when not recording). */
      async stop({ handle = true } = {}) {
        if (handle) await t.handles();
        if (!record || !recording) return null;
        recording = false;
        const rel = clipFile(scene, clipName);
        const res = await recorder.stop(path.join(outDir, rel));
        const compressedMs = res.compressedMs;
        state.compressedMs += compressedMs;
        state.clips.push({ file: rel.replace(/\\/g, "/"), duration: res.duration, compressed: compressedNote(compressedMs), segments: res.segments });
        log(`  clip ${rel} (${res.duration.toFixed(1)} s)`);
        clipName = null;
        return res;
      },
      async pause() {
        if (record && recording) await recorder.pause();
      },
      async resume() {
        if (record && recording) await recorder.resume();
      },
    },
    hold: (ms) => sleep(ms),
    /** A still handle: 1.5 s with nothing moving. */
    handles: () => sleep(record ? HANDLE_MS : 250),

    // --- roles ---
    /** Absolute paths of a role in the capture Library. */
    roles: (name) => roleFiles(name),
    role: (name) => roleFiles(name)[0],

    // --- navigation ---
    async open(moduleId, { name } = {}) {
      const nav = { css: `[data-testid="nav-${moduleId}"] button` };
      const b = await find(nav, { wait: 600, required: false });
      if (b) {
        await t.click(nav);
      } else {
        await t.key("Mod+K");
        await sleep(250);
        await t.type(null, name ?? moduleId);
        await sleep(250);
        await t.key("Enter");
      }
      await sleep(700);
    },
    async openLibrary(folder) {
      const spec = { css: "button", text: "Library", exact: true };
      await t.click(spec);
      await sleep(700);
      if (folder) {
        await t.click({ text: folder });
        await sleep(500);
      }
    },

    // --- input ---
    async move(target) {
      const b = await find(target);
      const p = jitter(b);
      await glide(p.x, p.y);
      return b;
    },
    async hover(target, ms = 600) {
      await t.move(target);
      await sleep(ms);
    },
    async click(target, { double = false, right = false } = {}) {
      const b = await find(target);
      const p = jitter(b);
      await glide(p.x, p.y);
      await sleep(110);
      await pressAt(p.x, p.y, { right, count: double ? 2 : 1 });
      await sleep(260);
      return b;
    },
    async drag(from, to, { steps = 24 } = {}) {
      const a = await find(from);
      const pa = jitter(a);
      await glide(pa.x, pa.y);
      await sleep(120);
      await cdp.mouse("mousePressed", pa.x, pa.y, { clickCount: 1, buttons: 1 });
      await sleep(120);
      const b = await find(to);
      const pb = jitter(b);
      const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      const dur = cursor.moveDuration(dist);
      for (let i = 1; i <= steps; i++) {
        const p = cursor.pathPoint(pa, pb, i / steps);
        await cdp.mouse("mouseMoved", Math.round(p.x), Math.round(p.y), { buttons: 1 });
        await sleep(dur / steps);
      }
      await sleep(120);
      await cdp.mouse("mouseReleased", pb.x, pb.y, { clickCount: 1, buttons: 0 });
      pos = pb;
      await sleep(300);
    },
    /**
     * A freehand stroke with the real mouse: glides to the first point, presses, follows `points` ([{x, y}], page
     * coordinates, linearly interpolated at `stepPx` per move) and releases. For painting / drawing scenes.
     */
    async stroke(points, { stepPx = 7, delay = 9 } = {}) {
      if (points.length < 2) throw new Error("stroke needs at least two points");
      await glide(points[0].x, points[0].y);
      await sleep(80);
      await cdp.mouse("mousePressed", points[0].x, points[0].y, { clickCount: 1, buttons: 1 });
      let last = points[0];
      for (let i = 1; i < points.length; i++) {
        const b = points[i];
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - last.x, b.y - last.y) / stepPx));
        for (let k = 1; k <= n; k++) {
          const x = Math.round(last.x + ((b.x - last.x) * k) / n);
          const y = Math.round(last.y + ((b.y - last.y) * k) / n);
          await cdp.mouse("mouseMoved", x, y, { buttons: 1 });
          await sleep(delay);
        }
        last = b;
      }
      await cdp.mouse("mouseReleased", last.x, last.y, { clickCount: 1, buttons: 0 });
      pos = { x: last.x, y: last.y };
      await sleep(250);
    },
    /** Types at 12-18 characters per second. `target` (optional) is clicked first; null types where focus is. */
    async type(target, text) {
      if (target) await t.click(target);
      const delays = typingDelays(text, rng);
      let i = 0;
      for (const ch of Array.from(text)) {
        await sleep(delays[i++]);
        if (ch === "\n") await t.key("Enter", { chip: false });
        else await cdp.insertText(ch);
      }
      await sleep(180);
    },
    /** A key or chord ("Mod+K", "Enter", "Shift+Tab"). Chords with Ctrl/Alt/Cmd show a caption chip. */
    async key(combo, { chip } = {}) {
      const k = parseCombo(combo);
      const showChip = chip ?? !!(k.modifiers & (MOD.Ctrl | MOD.Alt | MOD.Meta));
      if (showChip) await page(`window.__demoCursor.chip(${lit(k.label)})`);
      const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers };
      await cdp.keyEvent({ type: k.text !== undefined ? "keyDown" : "rawKeyDown", ...base, ...(k.text !== undefined ? { text: k.text } : {}) });
      await sleep(40);
      await cdp.keyEvent({ type: "keyUp", ...base });
      await sleep(showChip ? 420 : 120);
    },
    async scroll(target, dy, ms = 800) {
      const b = target ? await find(target) : { x: 960, y: 540, w: 100, h: 100 };
      await glide(b.x, b.y);
      const n = Math.max(1, Math.round(ms / 16));
      let sent = 0;
      for (let i = 1; i <= n; i++) {
        const want = Math.round(dy * cursor.ease(i / n));
        const step = want - sent;
        sent = want;
        if (step !== 0) await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: b.x, y: b.y, deltaX: 0, deltaY: step });
        await sleep(16);
      }
      await sleep(200);
    },
    async exists(spec) {
      return !!(await page(`window.__demo.exists(${lit(spec)})`));
    },
    /** Waits until a selector/text is on screen (or a function of the page returns truthy). */
    async waitFor(spec, ms = 15000) {
      await find(spec, { wait: ms });
    },

    // --- files ---
    /** Hands files to a tool like a drop on its sidebar row does. */
    async handOff(moduleId, ...roleNames) {
      const paths = roleNames.flatMap((r) => (r.includes("/") || r.includes("\\") ? [r] : roleFiles(r)));
      if (paths.length === 0) throw new Error("handOff: no files");
      // A falsy moduleId drops on the window itself: the app then offers the tools that take those files.
      const id = moduleId ? `tool-drop:${moduleId}` : "";
      const b = id ? await find({ css: `[id="${id}"]` }, { wait: 800, required: false }) : { x: 960, y: 560, w: 200, h: 200 };
      if (b) {
        const p = jitter(b);
        await glide(p.x, p.y);
        await sleep(200);
        await page(`window.__demoCursor.ripple(${p.x},${p.y})`);
      }
      await page(`window.__demo.drop(${lit(b ? id : "")}, ${lit(paths)})`);
      await sleep(900);
      return paths;
    },
    /**
     * Inside an open "From Library" picker: searches for each file of the role, picks it and confirms.
     * (Open the picker yourself first: t.click("From Library…").)
     */
    async pickFromLibrary(role) {
      const files = roleFiles(role);
      const dlg = '[role="dialog"]';
      for (const f of files) {
        const base = path.basename(f);
        await t.type(`${dlg} [aria-label="Search the Library"]`, path.parse(base).name);
        await sleep(700);
        await t.click({ within: dlg, css: "ul button", text: base });
        if (files.length > 1) {
          // Clear the search for the next file.
          await page(`(()=>{const i=document.querySelector('${dlg} [aria-label="Search the Library"]');if(i){i.focus();i.select()}})()`);
          await t.key("Backspace", { chip: false });
        }
      }
      await t.click({ within: dlg, css: "button", textRe: "^(use|add)( \\d+)?$" });
      await sleep(900);
    },

    // --- jobs ---
    /** Calls a bound Wails method: svc("toolbox/api.JobsService", "List", filter). */
    async svc(service, method, ...args) {
      return page(`window.__demo.call(${lit(`${service}.${method}`)}, ${lit(args)})`);
    },
    async jobs() {
      const list = await t.svc("toolbox/api.JobsService", "List", { moduleId: "", statuses: null, limit: 60, pipelineRunId: "" });
      return list ?? [];
    },
    /**
     * Waits for the jobs created since the last call (or scene start) to finish. With `compress`, recording is
     * paused once a job has run for `after` ms and resumed (with a 0.4 s dissolve) when it ends.
     */
    async waitJob({ compress = false, moduleId, timeoutMs = 20 * 60000, allowFail = false, appearMs = 20000, after = 2500, settle = 700 } = {}) {
      const started = Date.now();
      let paused = false;
      let seen = false;
      let relevant = [];
      try {
        for (;;) {
          const all = await t.jobs();
          relevant = all.filter((j) => !j.quiet && (!moduleId || j.moduleId === moduleId) && j.createdAt >= jobMark - 1000);
          const active = relevant.filter((j) => j.status === "queued" || j.status === "running");
          if (relevant.length > 0) seen = true;
          if (seen && active.length === 0) break;
          const waited = Date.now() - started;
          if (!seen && waited > appearMs) throw new Error("waitJob: no job appeared");
          if (waited > timeoutMs) throw new Error("waitJob: timed out");
          if (compress && !paused && active.length > 0 && waited > after) {
            await t.rec.pause();
            paused = true;
          }
          await sleep(paused ? 1000 : 400);
        }
      } finally {
        if (paused) await t.rec.resume();
      }
      jobMark = Date.now();
      const failed = relevant.filter((j) => j.status === "failed");
      if (failed.length && !allowFail) throw new Error(`job failed: ${failed[0].title}: ${failed[0].error}`);
      await sleep(settle);
      return relevant;
    },

    // --- outputs ---
    /** A 1920x1080 PNG of the current screen into <out>/Stills. */
    async still(name) {
      const nn = String(scene.number).padStart(2, "0");
      const rel = path.join("Stills", `${nn} ${safeName(name ?? scene.title)}.png`);
      await takeStill(cdp, path.join(outDir, rel));
      state.stills.push(rel.replace(/\\/g, "/"));
      return rel;
    },
    /** What is being shown (and optionally a suggested voice-over line) for the shot list. */
    note(text, vo) {
      state.notes.push(text);
      if (vo) state.vo.push(vo);
    },

    // --- safety / misc ---
    /** Throws while a Toolbox the harness didn't start is running (the clipboard scene must not share a machine with one). */
    requireNoOtherToolbox() {
      const others = otherToolboxProcesses(ctx.appPid ? [ctx.appPid] : []);
      if (others.length) throw new Error(`another Toolbox is running (pid ${others.map((o) => o.pid).join(", ")}): close it first`);
    },
    eval: (expr) => page(expr),
    /** Closes menus and dialogs without recording anything odd. */
    async reset() {
      for (let i = 0; i < 2; i++) await t.key("Escape", { chip: false });
    },
    /** Where this run's clips go (for scenes that make a clip outside the screen recorder). */
    get outDir() {
      return outDir;
    },
    /** Lists a clip a scene made itself (FFmpeg) in the shot list: `rel` is relative to outDir. */
    registerClip(rel, duration) {
      state.clips.push({ file: rel.replace(/\\/g, "/"), duration, compressed: "", segments: [] });
    },
    setListing(l) {
      listing = l;
    },
    markJobs() {
      jobMark = Date.now();
    },
    get cursor() {
      return { ...pos };
    },
  };
  return { t, state, isRecording: () => recording };
}
