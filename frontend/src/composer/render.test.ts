import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComposerLayer, Composition } from "@/lib/api";
import { newComposition, newImageLayer, newTextLayer } from "./model";
import { clearRenderCache, imagePaths, layerSize, renderComposition, setCanvasFactory, textLayout, type Ctx2D, type ImageMap } from "./render";

// A recording 2D context: every call and property set is appended to a shared
// log as "<canvas>|<op>|<args>", so the tests can check what was drawn, in
// which order and on which canvas.

interface Fake {
  log: string[];
  made: number;
  main: Ctx2D;
  factory: (w: number, h: number) => HTMLCanvasElement;
}

function fmt(v: unknown): string {
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  if (v && typeof v === "object" && "__canvas" in v) return `#${(v as { __canvas: string }).__canvas}`;
  if (v && typeof v === "object" && "__bitmap" in v) return "bitmap";
  return String(v);
}

function makeFake(): Fake {
  const log: string[] = [];
  const fake: Fake = { log, made: 0, main: null as unknown as Ctx2D, factory: null as never };
  const make = (id: string, width: number, height: number) => {
    const state: Record<string, unknown> = { font: "10px Arial" };
    const rec = (op: string, args: unknown[]) => log.push(`${id}|${op}|${args.map(fmt).join(",")}`);
    const methods: Record<string, (...a: unknown[]) => unknown> = {
      measureText: (text) => {
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 10);
        return { width: String(text).length * px * 0.5 };
      },
      getImageData: (_x, _y, w, h) => {
        rec("getImageData", [w, h]);
        return { data: new Uint8ClampedArray(Number(w) * Number(h) * 4).fill(100), width: w, height: h };
      },
      createLinearGradient: (...a) => {
        rec("createLinearGradient", a);
        return { addColorStop: (o: unknown, c: unknown) => rec("addColorStop", [o, c]) };
      },
    };
    const ctx: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "canvas") return { __canvas: id, width, height };
          if (methods[prop]) {
            return (...a: unknown[]) => {
              if (!["measureText"].includes(prop) && !["getImageData", "createLinearGradient"].includes(prop)) rec(prop, a);
              return methods[prop]?.(...a);
            };
          }
          if (prop in state) return state[prop];
          return (...a: unknown[]) => rec(prop, a);
        },
        set(_t, prop: string, value) {
          state[prop] = value;
          rec(`set:${prop}`, [value]);
          return true;
        },
      },
    );
    return ctx;
  };
  let n = 0;
  fake.main = make("main", 0, 0) as Ctx2D;
  fake.factory = (w, h) => {
    const id = `c${++n}`;
    fake.made++;
    const ctx = make(id, w, h);
    return { __canvas: id, width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement;
  };
  return fake;
}

const bitmap = (w: number, h: number) => ({ __bitmap: true, width: w, height: h }) as unknown as ImageBitmap;

function doc(): Composition {
  const d = newComposition("4:5");
  const photo = newImageLayer("/photo.png", 2000, 1000, d);
  photo.id = "photo";
  photo.outline = { on: true, width: 0.01, color: "#ffffff" };
  photo.shadow = { on: true, blur: 0.02, offsetX: 0, offsetY: 0.01, opacity: 0.4, color: "#000000" };
  photo.look = { preset: "vivid", brightness: 0, contrast: 0, saturation: 0, warmth: 0 };
  photo.image = { ...(photo.image as NonNullable<ComposerLayer["image"]>), radius: 0.1 };
  photo.rotation = 10;
  const text = newTextLayer(d);
  text.id = "text";
  text.text = { ...(text.text as NonNullable<ComposerLayer["text"]>), text: "Hello\nworld", pill: "#ff0000" };
  text.outline = { on: true, width: 0.004, color: "#00ff00" };
  text.shadow = { on: true, blur: 0.01, offsetX: 0.005, offsetY: 0.005, opacity: 0.5, color: "#000000" };
  return { ...d, layers: [photo, text] };
}

const images = (): ImageMap => new Map([["/photo.png", bitmap(2000, 1000)]]);

let fake: Fake;
beforeEach(() => {
  fake = makeFake();
  setCanvasFactory(fake.factory);
});
afterEach(() => {
  setCanvasFactory(null);
  clearRenderCache();
});

const mainOps = () => fake.log.filter((l) => l.startsWith("main|")).map((l) => l.split("|").slice(1).join("|"));

describe("renderComposition", () => {
  it("draws background, then the image layer, then the text layer on the main context", () => {
    renderComposition(fake.main, doc(), images(), { scale: 1 });
    const ops = mainOps();
    const fill = ops.indexOf("fillRect|0,0,1080,1350");
    const imageShadow = ops.findIndex((o) => o.startsWith("set:shadowBlur|") && o.endsWith("21.6"));
    const draws = ops.map((o, i) => (o.startsWith("drawImage|") ? i : -1)).filter((i) => i >= 0);
    const textShadow = ops.findIndex((o) => o.startsWith("set:shadowBlur|") && o.endsWith("10.8"));
    expect(fill).toBe(ops.findIndex((o) => o.startsWith("fillRect")));
    expect(fill).toBeGreaterThanOrEqual(0);
    expect(draws).toHaveLength(2); // one sprite per layer
    expect(imageShadow).toBeGreaterThan(fill);
    expect(imageShadow).toBeLessThan(draws[0] as number);
    expect(textShadow).toBeGreaterThan(draws[0] as number);
    expect(textShadow).toBeLessThan(draws[1] as number);
    // The shadow offset is in canvas pixels (0.01 × 1080).
    expect(ops).toContain("set:shadowOffsetY|10.8");
    // The image layer is rotated 10° about its centre (x 0.5, y 0.5 of the canvas).
    expect(ops).toContain("translate|540,675");
    expect(ops.some((o) => o.startsWith("rotate|0.17"))).toBe(true);
    expect(ops.at(-1)).toBe("restore|");
  });

  it("builds the image sprite crop → clip → look → outline → picture", () => {
    renderComposition(fake.main, doc(), images(), { scale: 1 });
    const spriteLog = fake.log.filter((l) => !l.startsWith("main|"));
    // First offscreen canvas made is the image layer's picture (the text measurer is c1).
    const byCanvas = (id: string) => spriteLog.filter((l) => l.startsWith(`${id}|`)).map((l) => l.split("|").slice(1).join("|"));
    const ids = [...new Set(spriteLog.map((l) => l.split("|")[0] as string))];
    const content = ids.map(byCanvas).find((ops) => ops.some((o) => o.startsWith("drawImage|bitmap")));
    expect(content).toBeDefined();
    const ops = content as string[];
    const clip = ops.indexOf("clip|");
    const draw = ops.findIndex((o) => o.startsWith("drawImage|bitmap"));
    const get = ops.findIndex((o) => o.startsWith("getImageData"));
    const put = ops.findIndex((o) => o.startsWith("putImageData"));
    expect(clip).toBeGreaterThanOrEqual(0);
    expect(draw).toBeGreaterThan(clip);
    expect(get).toBeGreaterThan(draw);
    expect(put).toBeGreaterThan(get);

    // The outline mask is tinted with source-in, then drawn 16× per ring under the picture.
    const maskOps = ids.map(byCanvas).find((o) => o.includes("set:globalCompositeOperation|source-in"));
    expect(maskOps).toBeDefined();
    expect(maskOps).toContain("set:fillStyle|#ffffff");
    const full = ids.map(byCanvas).find((o) => o.filter((x) => x.startsWith("drawImage|#")).length > 16);
    expect(full).toBeDefined();
    const draws = (full as string[]).filter((x) => x.startsWith("drawImage|"));
    // 10.8 px outline: two rings of 16, then the picture itself.
    expect(draws).toHaveLength(33);
    const [maskDraw, contentDraw] = [draws[0] as string, draws[32] as string];
    expect(maskDraw.split(",")[0]).not.toBe(contentDraw.split(",")[0]);
  });

  it("lays out text on the text sprite: pill, stroke before fill, one line per newline", () => {
    renderComposition(fake.main, doc(), images(), { scale: 1 });
    const text = fake.log.filter((l) => /\|(fillText|strokeText)\|/.test(l));
    const ops = text.map((l) => l.split("|")[1]);
    expect(ops).toEqual(["strokeText", "fillText", "strokeText", "fillText"]);
    expect(fake.log.some((l) => l.includes("|set:fillStyle|#ff0000"))).toBe(true);
    expect(fake.log.some((l) => l.includes("|set:strokeStyle|#00ff00"))).toBe(true);
    expect(fake.log.some((l) => l.includes("|set:textAlign|center"))).toBe(true);
  });

  it("draws a gradient background", () => {
    const d = newComposition("1:1");
    d.background = { ...d.background, kind: "gradient", color: "#ff0000", color2: "#0000ff", angle: 90 };
    renderComposition(fake.main, d, new Map(), { scale: 1 });
    const ops = mainOps();
    expect(ops).toContain("createLinearGradient|0,540,1080,540");
    expect(ops).toContain("addColorStop|0,#ff0000");
    expect(ops).toContain("addColorStop|1,#0000ff");
  });

  it("cover-fits a background photo with pan and zoom and blurs through an offscreen", () => {
    const d = newComposition("1:1");
    d.background = { ...d.background, kind: "image", image: { path: "/bg.png", original: "" }, zoom: 2, panX: 1, panY: 0, blur: 0 };
    const map: ImageMap = new Map([["/bg.png", bitmap(2000, 1000)]]);
    renderComposition(fake.main, d, map, { scale: 1 });
    // cover: 1080/1000 = 1.08, zoom 2 → 4320×2160, panX 1 → right edge flush.
    expect(mainOps()).toContain("drawImage|bitmap,-3240,-540,4320,2160");

    fake.log.length = 0;
    d.background = { ...d.background, zoom: 1, panX: 0, blur: 0.5 };
    renderComposition(fake.main, d, map, { scale: 1 });
    // Blur: the photo goes through offscreen canvases (halve then double), then onto the main one.
    expect(fake.made).toBeGreaterThan(2);
    expect(mainOps().filter((o) => o.startsWith("drawImage|#c"))).toHaveLength(1);
    expect(mainOps().some((o) => o.startsWith("drawImage|bitmap"))).toBe(false);
  });

  it("skips hidden layers and layers whose image is missing", () => {
    const d = doc();
    d.layers = [{ ...(d.layers?.[0] as ComposerLayer), hidden: true }, { ...(d.layers?.[1] as ComposerLayer), hidden: true }];
    renderComposition(fake.main, d, images(), { scale: 1 });
    expect(mainOps().filter((o) => o.startsWith("drawImage"))).toHaveLength(0);
    fake.log.length = 0;
    renderComposition(fake.main, { ...d, layers: [(doc().layers as ComposerLayer[])[0] as ComposerLayer] }, new Map(), { scale: 1 });
    expect(mainOps().filter((o) => o.startsWith("drawImage"))).toHaveLength(0);
  });

  it("is deterministic and scales every length", () => {
    renderComposition(fake.main, doc(), images(), { scale: 1 });
    const first = [...fake.log];
    setCanvasFactory(null);
    fake = makeFake();
    setCanvasFactory(fake.factory);
    renderComposition(fake.main, doc(), images(), { scale: 1 });
    // Layer IDs come from the document, so two renders of equal documents log the same.
    expect(fake.log).toEqual(first);

    fake.log.length = 0;
    renderComposition(fake.main, doc(), images(), { scale: 0.5 });
    expect(mainOps()).toContain("fillRect|0,0,540,675");
    expect(mainOps()).toContain("translate|270,337.5");
  });

  it("reuses a layer's sprite when it only moves, fades or rotates", () => {
    const d = doc();
    const imgs = images();
    renderComposition(fake.main, d, imgs, { scale: 1 });
    const made = fake.made;
    const moved: Composition = {
      ...d,
      layers: (d.layers as ComposerLayer[]).map((l) => ({ ...l, x: l.x + 0.1, rotation: l.rotation + 5, opacity: 0.5 })),
    };
    renderComposition(fake.main, moved, imgs, { scale: 1 });
    expect(fake.made).toBe(made);
    // A different crop, outline or size rebuilds it.
    const bigger = { ...d, layers: (d.layers as ComposerLayer[]).map((l) => ({ ...l, size: l.size * 1.2 })) };
    renderComposition(fake.main, bigger, imgs, { scale: 1 });
    expect(fake.made).toBeGreaterThan(made);
  });
});

describe("render helpers", () => {
  it("imagePaths lists the background and image layers once", () => {
    const d = doc();
    d.background = { ...d.background, kind: "image", image: { path: "/bg.png", original: "" } };
    d.layers = [...(d.layers as ComposerLayer[]), newImageLayer("/photo.png", 10, 10, d)];
    expect(imagePaths(d).sort()).toEqual(["/bg.png", "/photo.png"]);
    d.background = { ...d.background, kind: "color" };
    expect(imagePaths(d)).toEqual(["/photo.png"]);
  });

  it("layerSize follows the crop and the picture", () => {
    const d = doc();
    const photo = d.layers?.[0] as ComposerLayer;
    const s = layerSize(d, photo, images());
    expect(s.w).toBeCloseTo(photo.size * 1080);
    expect(s.h).toBeCloseTo(s.w / 2); // 2000×1000
    const cropped = { ...photo, image: { ...(photo.image as NonNullable<ComposerLayer["image"]>), crop: { x: 0, y: 0, w: 0.5, h: 1 } } };
    expect(layerSize(d, cropped, images()).h).toBeCloseTo(s.w);
    expect(layerSize(d, photo, new Map()).h).toBeCloseTo(s.w); // unknown picture: square
  });

  it("measures text per line", () => {
    const t = d2().layers?.[0] as ComposerLayer;
    const one = textLayout(t, 1080, 1);
    expect(one.lines).toEqual(["Hello", "world!!"]);
    expect(one.blockW).toBeCloseTo(7 * one.fontPx * 0.5);
    expect(one.blockH).toBeCloseTo(2 * one.fontPx * 1.2);
    expect(one.boxW).toBeCloseTo(one.blockW); // no pill
    const pill = textLayout({ ...t, text: { ...(t.text as NonNullable<ComposerLayer["text"]>), pill: "#fff000" } }, 1080, 1);
    expect(pill.boxW).toBeGreaterThan(one.boxW);
    expect(textLayout(t, 1080, 2).fontPx).toBeCloseTo(one.fontPx * 2);
  });
});

function d2(): Composition {
  const d = newComposition("4:5");
  const t = newTextLayer(d);
  t.text = { ...(t.text as NonNullable<ComposerLayer["text"]>), text: "Hello\nworld!!", pill: "" };
  return { ...d, layers: [t] };
}
