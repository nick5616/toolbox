/**
 * PaintLab (Phase 19, SPEC §5): a dev-only window (`TOOLBOX_PAINTLAB=1
 * TOOLBOX_VIEW=paintlab`) that replays recorded strokes per brush preset on the
 * real WebGL2 engine and writes, over the raw-message channel, into
 * <support>/tmp/paintlab/:
 *   - <preset id>.png      one stroke sheet per preset (mode `all`)
 *   - sheet-<set>.png      one sheet per brush set
 *   - hash.json            a hash of every preset's pixels (goldens: diff two runs)
 *   - fps.json             frame time at 120 Hz synthetic input on 3840×2160
 *
 * Query: `?window=paintlab[&only=<preset id>][&mode=sheets|fps|all]`
 * (sheets = sheets + hashes, fps = the probe only, all = everything + one PNG per preset).
 */
import { System } from "@wailsio/runtime";
import { useEffect, useState } from "react";
import { toBase64 } from "@/viz/worker/transport";
import { createPaintEngine } from "../engine/engine";
import { browserCodec } from "../engine/codec";
import { straightImage } from "../engine/pixels";
import { blankDocForLab } from "./doc";
import { allPresets, libResolver } from "./presets";
import { defaultBrush } from "../brushes/defaults";
import { lineStroke, loopStroke, probeStroke, vlineStroke, waveStroke } from "./strokes";
import type { BrushPreset } from "../brushes/schema";
import type { InputPoint, PaintEngine, RGBA, TileSource, ToolState } from "../engine/types";
import type { PaintEngineExt } from "../engine/engine";

const send = (name: string, bytes: Uint8Array) => System.invoke(`plab|${name}|${toBase64(bytes)}`);
const sendJSON = (name: string, v: unknown) => send(name, new TextEncoder().encode(JSON.stringify(v, null, 1)));

function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ (bytes[i] as number), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

const noTiles: TileSource = { load: async () => new Map() };
const INK: RGBA = { r: 0.08, g: 0.1, b: 0.16, a: 1 };
const LIGHT: RGBA = { r: 1, g: 0.72, b: 0.32, a: 1 };
const LIGHT2: RGBA = { r: 0.4, g: 0.7, b: 1, a: 1 };
const SEC: RGBA = { r: 0.9, g: 0.4, b: 0.2, a: 1 };
const codec = browserCodec();

function tool(brush: BrushPreset, seed: number): ToolState {
  return { kind: "brush", brush, color: INK, secondary: SEC, seed };
}

function play(e: PaintEngine, t: ToolState, pts: InputPoint[]): void {
  e.beginStroke(t, pts[0] as InputPoint);
  // Four events per frame, like a 120 Hz pen on a 30 Hz hitch, to exercise coalescing.
  for (let i = 1; i < pts.length; i += 4) e.extendStroke(pts.slice(i, i + 4), pts.slice(i + 4, i + 6));
  e.endStroke();
}

const CELL_W = 720;
const CELL_H = 250;
const COLS = 2;
const ROWS_PER_SHEET = 8;
const DARK = "#14161c";
const PAPER = "#fbfaf6";

/** Brushes that add light need a dark ground and a light colour to be seen. */
const isLight = (p: BrushPreset) => p.blend === "add" || p.blend === "screen";
const isSmudge = (p: BrushPreset) => p.set === "Smudge" || p.id.includes("smudge");
const isEraser = (p: BrushPreset) => p.blend === "erase";

const BAND: RGBA[] = [
  { r: 0.86, g: 0.25, b: 0.2, a: 1 },
  { r: 0.15, g: 0.45, b: 0.85, a: 1 },
  { r: 0.95, g: 0.75, b: 0.15, a: 1 },
  { r: 0.2, g: 0.62, b: 0.35, a: 1 },
];

/** Pre-paint a coloured ground so erasers and smudge brushes have something to act on. */
function prepaint(engine: PaintEngine, smudge: boolean): void {
  const flat = (size: number): BrushPreset => defaultBrush({ id: "lab-ground", size, spacing: 0.05, minSize: 1 });
  const dyn = (c: RGBA, seed: number): ToolState => ({ kind: "brush", brush: flat(smudge ? 36 : 70), color: c, secondary: c, seed });
  if (smudge) {
    for (let i = 0; i < 21; i++) play(engine, dyn(BAND[i % BAND.length] as RGBA, 1 + i), vlineStroke(18 + i * 34, -10, CELL_H + 10));
  } else {
    BAND.slice(0, 3).forEach((c, i) => play(engine, dyn(c, 1 + i), lineStroke(0, CELL_W, 50 + i * 75, 0.8, 0.8)));
  }
}

/** Every stroke a preset is judged by: pressure ramp, slow, fast, tilted, a wave and a loop. */
function testStrokes(p: BrushPreset): Array<{ pts: InputPoint[]; seed: number }> {
  const big = p.size > 60;
  const dy = big ? 10 : 0;
  return [
    { pts: lineStroke(24, 300, 52 + dy, 0.05, 1, 3), seed: 11 }, // pressure ramp
    { pts: lineStroke(24, 300, 104 + dy, 0.6, 0.6, 1.2), seed: 12 }, // slow
    { pts: lineStroke(24, 300, 152 + dy, 0.6, 0.6, 14), seed: 13 }, // fast
    { pts: lineStroke(24, 300, 204 + dy, 0.6, 0.6, 3, 55, 0), seed: 14 }, // tilted
    { pts: waveStroke(340, CELL_W - 30, 80, 34), seed: 15 },
    { pts: loopStroke(430, 180, 42), seed: 16 },
    { pts: waveStroke(520, CELL_W - 40, 190, 18, 2), seed: 17 },
  ];
}

/** Big brushes are shown at this size so the whole stroke fits the cell. */
const MAX_SIZE = 72;

async function renderPreset(engine: PaintEngine & PaintEngineExt, preset: BrushPreset): Promise<{ png: Uint8Array; hash: string; w: number; h: number; dark: boolean; note: string }> {
  const p = preset.size > MAX_SIZE ? { ...preset, size: MAX_SIZE } : preset;
  const note = preset.size > MAX_SIZE ? `size ${Math.round(preset.size)} shown at ${MAX_SIZE}` : `size ${Math.round(preset.size * 10) / 10}`;
  const dark = isLight(p);
  await engine.load(blankDocForLab(CELL_W, CELL_H, dark ? DARK : PAPER), noTiles);
  await engine.prepareBrush(p);
  const smudge = isSmudge(p);
  if (smudge || isEraser(p)) prepaint(engine, smudge);
  for (const s of testStrokes(p)) {
    const t: ToolState = smudge
      ? { kind: "smudge", brush: p, seed: s.seed }
      : { kind: "brush", brush: p, color: dark ? LIGHT : INK, secondary: dark ? LIGHT2 : SEC, seed: s.seed };
    play(engine, t, s.pts);
  }
  const px = engine.readPixels({ x: 0, y: 0, w: CELL_W, h: CELL_H }, "merged");
  const straight = straightImage(px);
  return { png: await codec.encode({ data: straight.data, width: CELL_W, height: CELL_H }), hash: fnv(new Uint8Array(px.data.buffer, px.data.byteOffset, px.data.byteLength)), w: CELL_W, h: CELL_H, dark, note };
}

/** A 6× nearest-neighbour crop of the slow and fast lines, to judge edges pixel by pixel. */
async function zoomCrop(png: Uint8Array): Promise<Uint8Array> {
  const bmp = await createImageBitmap(new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }));
  const c = new OffscreenCanvas(720, 480);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 150, 84, 120, 80, 0, 0, 720, 480);
  bmp.close();
  return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
}

async function sheets(engine: PaintEngine & PaintEngineExt, presets: BrushPreset[], perPreset: boolean, say: (s: string) => void): Promise<void> {
  const hashes: Record<string, string> = {};
  const bySet = new Map<string, Array<{ p: BrushPreset; png: Uint8Array; dark: boolean; note: string }>>();
  for (const [i, p] of presets.entries()) {
    say(`${i + 1}/${presets.length} ${p.name}`);
    const r = await renderPreset(engine, p);
    hashes[p.id] = r.hash;
    if (perPreset) {
      send(`${p.id}.png`, r.png);
      send(`${p.id}-zoom.png`, await zoomCrop(r.png));
    }
    const list = bySet.get(p.set) ?? [];
    list.push({ p, png: r.png, dark: r.dark, note: r.note });
    bySet.set(p.set, list);
  }
  for (const [set, all] of bySet) {
    const perSheet = ROWS_PER_SHEET * COLS;
    for (let page = 0; page * perSheet < all.length; page++) {
      const list = all.slice(page * perSheet, (page + 1) * perSheet);
      const rows = Math.ceil(list.length / COLS);
      const c = new OffscreenCanvas(CELL_W * COLS, CELL_H * rows);
      const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, c.width, c.height);
      for (const [i, it] of list.entries()) {
        const bmp = await createImageBitmap(new Blob([it.png as Uint8Array<ArrayBuffer>], { type: "image/png" }));
        const x = (i % COLS) * CELL_W;
        const y = Math.floor(i / COLS) * CELL_H;
        ctx.drawImage(bmp, x, y);
        ctx.fillStyle = it.dark ? "#e8e8e8" : "#222";
        ctx.font = "bold 14px sans-serif";
        ctx.fillText(it.p.name, x + 8, y + 18);
        ctx.font = "11px sans-serif";
        ctx.fillText(it.note, x + CELL_W - 150, y + 16);
        ctx.strokeStyle = "#8886";
        ctx.strokeRect(x + 0.5, y + 0.5, CELL_W - 1, CELL_H - 1);
        bmp.close();
      }
      const blob = await c.convertToBlob({ type: "image/png" });
      const safe = set.replace(/[^A-Za-z0-9._-]+/g, "_");
      send(`sheet-${safe}${page === 0 ? "" : `-${page + 1}`}.png`, new Uint8Array(await blob.arrayBuffer()));
    }
  }
  sendJSON("hash.json", hashes);
}

/** Frame time at 120 Hz synthetic input on a 3840×2160 canvas (SPEC §6 acceptance 1: < 8 ms). */
async function fps(say: (s: string) => void): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 900;
  canvas.style.cssText = "position:fixed;left:0;top:0;width:1600px;height:900px";
  document.body.appendChild(canvas);
  const e = createPaintEngine({ resolver: libResolver });
  e.attach(canvas);
  const W = 3840;
  const H = 2160;
  await e.load(blankDocForLab(W, H, "#ffffff"), noTiles);
  e.setViewport(1600, 900);
  e.view.fit();
  const preset = allPresets().find((p) => p.id === "lab-hard-round") as BrushPreset;
  await e.prepareBrush(preset);
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
  const pts = probeStroke(W, H, 120 * 8); // 8 seconds of input
  const t = tool({ ...preset, size: 14 }, 7);
  const times: number[] = [];
  e.beginStroke(t, pts[0] as InputPoint);
  for (let i = 1; i < pts.length; i++) {
    say(`probe ${i}/${pts.length}`);
    const t0 = performance.now();
    e.extendStroke([pts[i] as InputPoint], pts.slice(i + 1, i + 3));
    e.render();
    gl.finish();
    times.push(performance.now() - t0);
    if (i % 60 === 0) await new Promise((r) => requestAnimationFrame(() => r(null))); // let the browser breathe
  }
  e.endStroke();
  times.sort((a, b) => a - b);
  const q = (f: number) => times[Math.min(times.length - 1, Math.floor(times.length * f))] as number;
  sendJSON("fps.json", {
    canvas: `${W}x${H}`,
    hz: 120,
    events: times.length,
    meanMs: times.reduce((a, b) => a + b, 0) / times.length,
    p50Ms: q(0.5),
    p95Ms: q(0.95),
    p99Ms: q(0.99),
    maxMs: times[times.length - 1],
    over8ms: times.filter((x) => x > 8).length,
    backend: e.backendName,
  });
  e.dispose();
  canvas.remove();
}

let started = false;

export default function PaintLab() {
  const [status, setStatus] = useState("starting…");
  useEffect(() => {
    if (started) return; // StrictMode runs effects twice in dev
    started = true;
    const q = new URLSearchParams(window.location.search);
    const mode = q.get("mode") ?? "sheets";
    const only = q.get("only");
    void (async () => {
      try {
        if (mode === "sheets" || mode === "all") {
          const canvas = document.createElement("canvas");
          canvas.width = CELL_W;
          canvas.height = CELL_H;
          const engine = createPaintEngine({ resolver: libResolver });
          engine.attach(canvas);
          await sheets(engine, allPresets(only), mode === "all", setStatus);
          engine.dispose();
        }
        if (mode === "fps" || mode === "all") await fps(setStatus);
        sendJSON("done.json", { ok: true, mode });
        setStatus("done");
      } catch (err) {
        sendJSON("done.json", { ok: false, error: String(err) });
        setStatus(`failed: ${String(err)}`);
      }
    })();
  }, []);
  return <pre style={{ margin: 12, fontFamily: "monospace" }}>PaintLab: {status}</pre>;
}
