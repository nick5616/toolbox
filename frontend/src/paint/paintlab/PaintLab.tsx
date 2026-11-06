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
import { loopStroke, probeStroke, waveStroke } from "./strokes";
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

async function renderPreset(engine: PaintEngine & PaintEngineExt, p: BrushPreset): Promise<{ png: Uint8Array; hash: string; w: number; h: number }> {
  const W = 640;
  const H = 200;
  await engine.load(blankDocForLab(W, H, "#fbfaf6"), noTiles);
  await engine.prepareBrush(p);
  const t = tool(p, 1234);
  play(engine, t, waveStroke(30, W - 30, 70, 32));
  play(engine, t, loopStroke(150, 140, 38));
  play(engine, { ...t, seed: 99 }, waveStroke(260, W - 40, 150, 16, 2));
  const px = engine.readPixels({ x: 0, y: 0, w: W, h: H }, "merged");
  const straight = straightImage(px);
  return { png: await codec.encode({ data: straight.data, width: W, height: H }), hash: fnv(new Uint8Array(px.data.buffer, px.data.byteOffset, px.data.byteLength)), w: W, h: H };
}

async function sheets(engine: PaintEngine & PaintEngineExt, presets: BrushPreset[], perPreset: boolean, say: (s: string) => void): Promise<void> {
  const hashes: Record<string, string> = {};
  const bySet = new Map<string, Array<{ p: BrushPreset; png: Uint8Array; w: number; h: number }>>();
  for (const [i, p] of presets.entries()) {
    say(`${i + 1}/${presets.length} ${p.name}`);
    const r = await renderPreset(engine, p);
    hashes[p.id] = r.hash;
    if (perPreset) send(`${p.id}.png`, r.png);
    const list = bySet.get(p.set) ?? [];
    list.push({ p, ...r });
    bySet.set(p.set, list);
  }
  for (const [set, list] of bySet) {
    const cols = 2;
    const rows = Math.ceil(list.length / cols);
    const c = new OffscreenCanvas(640 * cols, 200 * rows);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = "#fbfaf6";
    ctx.fillRect(0, 0, c.width, c.height);
    for (const [i, it] of list.entries()) {
      const bmp = await createImageBitmap(new Blob([it.png as Uint8Array<ArrayBuffer>], { type: "image/png" }));
      ctx.drawImage(bmp, (i % cols) * 640, Math.floor(i / cols) * 200);
      ctx.fillStyle = "#222";
      ctx.font = "13px sans-serif";
      ctx.fillText(it.p.name, (i % cols) * 640 + 8, Math.floor(i / cols) * 200 + 16);
      bmp.close();
    }
    const blob = await c.convertToBlob({ type: "image/png" });
    send(`sheet-${set.replace(/[^A-Za-z0-9._-]+/g, "_")}.png`, new Uint8Array(await blob.arrayBuffer()));
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
          canvas.width = 640;
          canvas.height = 200;
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
