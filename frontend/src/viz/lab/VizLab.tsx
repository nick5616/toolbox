/**
 * VizLab (SPEC.md §11.4): a dev-only window (`TOOLBOX_VIZLAB=1
 * TOOLBOX_VIEW=vizlab`) that renders every preset at five moments into PNG
 * contact sheets, measures preview fps and records frame hashes. Files go to
 * <support>/tmp/vizlab/ over the raw-message channel.
 *
 * Query: `?window=vizlab[&key=<analysis key>][&only=<preset id>]`.
 */
import { System } from "@wailsio/runtime";
import { useEffect, useRef, useState } from "react";
import { MediaService, VisualizerService } from "@/lib/api";
import { loadAnalysis, type Analysis } from "../analysis";
import { Engine } from "../engine";
import { buildFixture } from "../fixture";
import { layerDef } from "../layers/registry";
import { PRESETS, showFromPreset, type Preset } from "../presets";
import type { LayerType, Show } from "../types";
import { toBase64 } from "../worker/transport";

function send(name: string, bytes: Uint8Array): void {
  System.invoke(`vzlab|${name}|${toBase64(bytes)}`);
}
const sendJSON = (name: string, v: unknown) => send(name, new TextEncoder().encode(JSON.stringify(v, null, 1)));

function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 7) h = Math.imul(h ^ (bytes[i] ?? 0), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A show with one layer (default params) over a dim gradient in every scene,
 * for checking a single layer type (`TOOLBOX_VIZLAB_LAYER=<type>`).
 */
export function singleLayerShow(type: LayerType): Show {
  const base = showFromPreset(PRESETS[0] as Preset);
  const def = layerDef(type);
  for (const sc of base.scenes) {
    const bg = sc.layers.find((l) => l.type === "gradient");
    sc.layers = [
      ...(bg && def?.group !== "background" ? [bg] : []),
      { id: "lab", type, enabled: true, blend: def?.group === "background" ? "normal" : "add", opacity: 1, params: {} },
    ];
  }
  base.controls = [];
  base.name = `Layer: ${type}`;
  base.presetId = null;
  return base;
}

/** The five moments of a song: intro, verse, chorus, drop (or loudest bar), outro. */
export function moments(a: Analysis): Array<[string, number]> {
  const mid = (label: string) => {
    const s = a.audio.sections.find((x) => x.label === label);
    return s ? (s.startMs + s.endMs) / 2 : null;
  };
  let loud = 0;
  let loudT = a.durationMs / 2;
  for (let t = 0; t < a.durationMs; t += 500) {
    const v = a.sample("mix.level", t);
    if (v > loud) {
      loud = v;
      loudT = t;
    }
  }
  return [
    ["intro", mid("intro") ?? a.durationMs * 0.05],
    ["verse", mid("verse") ?? a.durationMs * 0.3],
    ["chorus", mid("chorus") ?? a.durationMs * 0.5],
    ["drop", mid("drop") ?? loudT],
    ["outro", mid("outro") ?? a.durationMs * 0.95],
  ];
}

async function pngOf(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
}

export default function VizLab() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    const say = (s: string) => setLog((l) => [...l, s]);
    const q = new URLSearchParams(window.location.search);
    let stop = false;
    (async () => {
      let a: Analysis;
      const key = q.get("key");
      if (key) {
        const r = await VisualizerService.Analysis(key);
        a = await loadAnalysis({
          audioJsonUrl: await MediaService.URLFor(r.audioJson),
          featuresUrl: await MediaService.URLFor(r.featuresPath),
          textJsonUrl: r.textJson ? await MediaService.URLFor(r.textJson) : undefined,
        });
        say(`analysis ${key}`);
      } else {
        a = buildFixture({ durationMs: 60_000 });
        say("synthetic fixture (60 s)");
      }
      const canvas = ref.current as HTMLCanvasElement;
      const only = q.get("only");
      const layer = q.get("layer") as LayerType | null;
      const presets: Preset[] = layer
        ? [{ id: `layer-${layer}`, name: layer, description: "", bestFor: "", show: singleLayerShow(layer) }]
        : PRESETS.filter((p) => !only || p.id === only);
      const fps: Record<string, number> = {};
      const hashes: Record<string, string[]> = {};
      for (const p of presets) {
        if (stop) return;
        const show = showFromPreset(p);
        const engine = new Engine(canvas, { width: 960, height: 540, mode: "opaque", quality: "full", seed: 1, fps: 30, inWorker: false });
        engine.setAnalysis(a);
        engine.setShow(show);
        for (const [m, t] of moments(a)) {
          engine.render(t);
          send(`${p.id}-${m}.png`, await pngOf(canvas));
        }
        engine.resize(1280, 720);
        const t0 = performance.now();
        const start = a.durationMs * 0.4;
        for (let i = 0; i < 300; i++) engine.render(start + (i * 1000) / 60);
        engine.gl.readPixels(0, 0, 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE, new Uint8Array(4)); // waits for the GPU
        fps[p.id] = Math.round((300 / ((performance.now() - t0) / 1000)) * 10) / 10;
        engine.resize(960, 540);
        hashes[p.id] = [];
        for (let i = 0; i < 10; i++) {
          engine.render(a.durationMs * (0.05 + i * 0.09));
          (hashes[p.id] as string[]).push(fnv(engine.readPixels()));
        }
        engine.dispose();
        say(`${p.id}: ${fps[p.id]} fps`);
      }
      sendJSON("fps.json", fps);
      sendJSON("hash.json", hashes);
      sendJSON("done.json", { presets: presets.length, at: new Date().toISOString() });
      say("done");
    })().catch((e: unknown) => {
      say(`error: ${String(e)}`);
      sendJSON("error.json", { error: String(e) });
    });
    return () => {
      stop = true;
    };
  }, []);
  return (
    <div style={{ padding: 16, fontFamily: "monospace", fontSize: 12 }}>
      <canvas ref={ref} style={{ width: 480, height: 270 }} />
      <pre>{log.join("\n")}</pre>
    </div>
  );
}
