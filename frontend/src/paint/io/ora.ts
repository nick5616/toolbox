// OpenRaster (.ora) read and write (stack.xml, data/*.png, mergedimage.png,
// Thumbnails/thumbnail.png). Layers keep opacity, visibility and composite-op;
// Paint+-only flags travel as `toolbox-*` attributes other readers ignore.
// PNG coding is injected (PngCodec), so tests run without a canvas.

import type { PngCodec, RawImage } from "../engine/codec";
import { BLEND_MODES } from "../engine/gl";
import { makeImageData, premultiplied, straightImage } from "../engine/pixels";
import type { PaintEngine } from "../engine/types";
import type { PaintEngineExt } from "../engine/engine";
import { readZip, writeZip, type ZipEntry } from "./zip";

export interface OraLayer {
  name: string;
  hidden: boolean;
  locked: boolean;
  alphaLock: boolean;
  clip: boolean;
  reference: boolean;
  opacity: number;
  blend: string;
  /** Offset of the image on the canvas. */
  x: number;
  y: number;
  image: RawImage;
}

export interface OraDoc {
  width: number;
  height: number;
  /** Bottom → top (stack.xml lists top first). */
  layers: OraLayer[];
  merged?: RawImage;
}

const OPS: Record<string, string> = {
  normal: "svg:src-over",
  add: "svg:plus",
};
const op = (blend: string) => OPS[blend] ?? `svg:${blend}`;
function blendOf(compositeOp: string): string {
  if (compositeOp === "svg:plus" || compositeOp === "svg:add") return "add";
  const m = /^svg:(.+)$/.exec(compositeOp);
  const name = m ? (m[1] as string) : "";
  if (name === "src-over") return "normal";
  return (BLEND_MODES as readonly string[]).includes(name) ? name : "normal";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function box(img: RawImage, size: number): RawImage {
  const k = Math.min(1, size / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  if (k === 1) return img;
  const src = premultiplied(img);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * img.width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w));
      const sy0 = Math.floor((y * img.height) / h);
      const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        for (let xx = sx0; xx < sx1; xx++) {
          const o = (yy * img.width + xx) * 4;
          r += src.data[o] as number;
          g += src.data[o + 1] as number;
          b += src.data[o + 2] as number;
          a += src.data[o + 3] as number;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return straightImage({ w, h, data: out });
}

export async function writeOra(doc: OraDoc, codec: PngCodec): Promise<Uint8Array> {
  const entries: ZipEntry[] = [{ name: "mimetype", data: new TextEncoder().encode("image/openraster") }];
  const xml: string[] = [];
  // stack.xml lists the top layer first.
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i] as OraLayer;
    const src = `data/layer${i}.png`;
    entries.push({ name: src, data: await codec.encode(l.image) });
    xml.push(
      `    <layer name="${esc(l.name)}" src="${src}" x="${l.x}" y="${l.y}" opacity="${l.opacity.toFixed(4)}" visibility="${l.hidden ? "hidden" : "visible"}" composite-op="${op(l.blend)}"` +
        `${l.locked ? ' edit-locked="true"' : ""}${l.alphaLock ? ' toolbox-alpha-lock="true"' : ""}${l.clip ? ' toolbox-clip="true"' : ""}${l.reference ? ' toolbox-reference="true"' : ""}/>`,
    );
  }
  const stack = `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.3" w="${doc.width}" h="${doc.height}">\n  <stack opacity="1" name="root">\n${xml.join("\n")}\n  </stack>\n</image>\n`;
  entries.splice(1, 0, { name: "stack.xml", data: new TextEncoder().encode(stack) });
  if (doc.merged) {
    entries.push({ name: "mergedimage.png", data: await codec.encode(doc.merged) });
    entries.push({ name: "Thumbnails/thumbnail.png", data: await codec.encode(box(doc.merged, 256)) });
  }
  return writeZip(entries);
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1] as string] = unesc(m[2] as string);
  return out;
}

export async function readOra(bytes: Uint8Array, codec: PngCodec): Promise<OraDoc> {
  const files = await readZip(bytes);
  const stack = files.get("stack.xml");
  if (!stack) throw new Error("not an OpenRaster file (no stack.xml)");
  const xml = new TextDecoder().decode(stack);
  const img = /<image\b([^>]*)>/.exec(xml);
  if (!img) throw new Error("stack.xml has no <image>");
  const ia = attrs(img[1] as string);
  const width = Number(ia.w);
  const height = Number(ia.h);
  if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384)) throw new Error("bad canvas size");
  const layers: OraLayer[] = [];
  for (const m of xml.matchAll(/<layer\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1] as string);
    const file = files.get(a.src ?? "");
    if (!file) continue;
    const image = await codec.decode(file);
    layers.push({
      name: a.name || "Layer",
      hidden: a.visibility === "hidden",
      locked: a["edit-locked"] === "true",
      alphaLock: a["toolbox-alpha-lock"] === "true",
      clip: a["toolbox-clip"] === "true",
      reference: a["toolbox-reference"] === "true",
      opacity: Math.max(0, Math.min(1, a.opacity === undefined ? 1 : Number(a.opacity))),
      blend: blendOf(a["composite-op"] ?? "svg:src-over"),
      x: Math.round(Number(a.x ?? 0)) || 0,
      y: Math.round(Number(a.y ?? 0)) || 0,
      image,
    });
  }
  layers.reverse();
  const mergedBytes = files.get("mergedimage.png");
  return { width, height, layers, merged: mergedBytes ? await codec.decode(mergedBytes) : undefined };
}

/** A layer's image placed on a full-canvas straight RGBA buffer (what the engine's tiles want). */
export function layerOnCanvas(l: OraLayer, width: number, height: number): ImageData {
  const out = makeImageData(width, height);
  for (let y = 0; y < l.image.height; y++) {
    const cy = y + l.y;
    if (cy < 0 || cy >= height) continue;
    for (let x = 0; x < l.image.width; x++) {
      const cx = x + l.x;
      if (cx < 0 || cx >= width) continue;
      const s = (y * l.image.width + x) * 4;
      out.data.set(l.image.data.subarray(s, s + 4), (cy * width + cx) * 4);
    }
  }
  return out;
}

/** The engine's layers (and flattened result) as an OraDoc. */
export function oraFromEngine(engine: PaintEngine & PaintEngineExt): OraDoc {
  const { width, height } = engine.doc;
  const full = { x: 0, y: 0, w: width, h: height };
  const layers: OraLayer[] = [];
  for (const l of engine.doc.layers ?? []) {
    const px = engine.readPixels(full, "layer", l.id);
    const im = straightImage(px);
    layers.push({
      name: l.name,
      hidden: l.hidden,
      locked: l.locked,
      alphaLock: l.alphaLock,
      clip: l.clip,
      reference: l.reference,
      opacity: l.opacity,
      blend: l.blend,
      x: 0,
      y: 0,
      image: { data: im.data, width, height },
    });
  }
  const merged = straightImage(engine.readPixels(full, "merged"));
  return { width, height, layers, merged: { data: merged.data, width, height } };
}
