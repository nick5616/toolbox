import { describe, expect, it } from "vitest";
import type { ComposerLayer, Composition } from "@/lib/api";
import {
  addLayer, ASPECTS, deleteLayer, duplicateLayer, findLayer, MAX_LAYERS, MAX_TEXT_CHARS, moveLayer, newComposition, newImageLayer,
  newTextLayer, reorderLayer, sanitizeComposition, setLayerSource, updateLayer,
} from "./model";

const ids = (d: Composition) => (d.layers ?? []).map((l) => l.id);

function docWith(...names: string[]): Composition {
  let d = newComposition("4:5");
  for (const n of names) {
    const l = newTextLayer(d);
    l.id = n;
    d = addLayer(d, l);
  }
  return d;
}

describe("factories", () => {
  it("newComposition matches the Go aspects", () => {
    for (const a of ASPECTS) {
      const d = newComposition(a.id);
      expect([d.width, d.height, d.aspect, d.version, d.format]).toEqual([a.width, a.height, a.id, 1, "jpg"]);
    }
    expect(newComposition("nonsense").aspect).toBe("4:5");
    expect(newComposition().background).toMatchObject({ kind: "color", color: "#ffffff", zoom: 1 });
  });

  it("newImageLayer fits within 60 % of the canvas, centred", () => {
    const d = newComposition("4:5"); // 1080×1350
    const wide = newImageLayer("/a/b/sunset.jpg", 4000, 1000, d);
    expect(wide.size * d.width).toBeCloseTo(0.6 * 1080);
    expect(wide.name).toBe("sunset");
    const tall = newImageLayer("C:\\x\\tall.png", 1000, 4000, d);
    expect((tall.size * d.width * 4000) / 1000).toBeCloseTo(0.6 * 1350); // height = 60 % of canvas height
    expect([tall.x, tall.y, tall.opacity]).toEqual([0.5, 0.5, 1]);
    expect(tall.image?.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(newImageLayer("/p.png", 0, 0, d).size).toBeGreaterThan(0);
    expect(new Set([wide.id, tall.id, newTextLayer(d).id]).size).toBe(3);
  });

  it("newTextLayer has a usable default", () => {
    const t = newTextLayer(newComposition());
    expect(t.kind).toBe("text");
    expect(t.text).toMatchObject({ text: "Text", font: "Arial", align: "center" });
  });
});

describe("sanitizeComposition", () => {
  it("never throws and always returns something valid", () => {
    for (const bad of [null, undefined, 5, "x", [], {}, { layers: "no" }, { layers: [null, 3, {}] }, { background: 4 }]) {
      const d = sanitizeComposition(bad);
      expect(d.version).toBe(1);
      expect(d.layers).toEqual([]);
      expect(d.width).toBe(1080);
    }
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => sanitizeComposition(cyc)).not.toThrow();
  });

  it("round-trips a valid document", () => {
    const d = docWith("a", "b");
    d.layers = [...(d.layers as ComposerLayer[]), newImageLayer("/p.png", 100, 50, d)];
    expect(sanitizeComposition(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it("clamps, defaults and repairs", () => {
    const d = docWith("a");
    const raw = JSON.parse(JSON.stringify(d)) as Composition;
    raw.aspect = "16:9";
    raw.width = 5;
    raw.background = { ...raw.background, kind: "image", image: null, zoom: 9, blur: -3, color: "red" };
    const l = (raw.layers as ComposerLayer[])[0] as ComposerLayer;
    l.opacity = 4;
    l.x = Number.NaN;
    l.text = { ...(l.text as NonNullable<ComposerLayer["text"]>), font: "Comic Sans", text: "é".repeat(MAX_TEXT_CHARS + 20), pill: "nope", lineHeight: 9 };
    l.shadow.color = "bad";
    raw.format = "gif";
    const out = sanitizeComposition(raw);
    expect([out.width, out.height]).toEqual([1920, 1080]);
    expect(out.background).toMatchObject({ kind: "color", zoom: 4, blur: 0, color: "#ffffff" });
    const ol = out.layers?.[0] as ComposerLayer;
    expect([ol.opacity, ol.x, ol.shadow.color]).toEqual([1, 0.5, "#000000"]);
    expect(ol.text).toMatchObject({ font: "Arial", pill: "", lineHeight: 2 });
    expect(Array.from(ol.text?.text ?? "")).toHaveLength(MAX_TEXT_CHARS);
    expect(out.format).toBe("jpg");
  });

  it("drops broken layers, renames duplicate ids and caps the count", () => {
    const d = docWith("a", "a");
    const raw = JSON.parse(JSON.stringify(d)) as Composition;
    raw.layers = [...(raw.layers as ComposerLayer[]), { kind: "image", image: null } as unknown as ComposerLayer, { kind: "text", text: null } as unknown as ComposerLayer];
    const out = sanitizeComposition(raw);
    expect(out.layers).toHaveLength(2);
    expect(new Set(ids(out)).size).toBe(2);
    const many = docWith(...Array.from({ length: MAX_LAYERS + 5 }, (_, i) => `n${i}`));
    expect(many.layers).toHaveLength(MAX_LAYERS); // addLayer stops at the cap
    const raw2 = { ...many, layers: [...(many.layers as ComposerLayer[]), ...(many.layers as ComposerLayer[])] };
    expect(sanitizeComposition(raw2).layers).toHaveLength(MAX_LAYERS);
  });
});

describe("layer operations", () => {
  it("move up/down/top/bottom (up = towards the top of the stack)", () => {
    const d = docWith("a", "b", "c");
    expect(ids(moveLayer(d, "a", "up"))).toEqual(["b", "a", "c"]);
    expect(ids(moveLayer(d, "c", "down"))).toEqual(["a", "c", "b"]);
    expect(ids(moveLayer(d, "a", "top"))).toEqual(["b", "c", "a"]);
    expect(ids(moveLayer(d, "c", "bottom"))).toEqual(["c", "a", "b"]);
    // Edges and unknown IDs change nothing (same object).
    expect(moveLayer(d, "c", "up")).toBe(d);
    expect(moveLayer(d, "a", "down")).toBe(d);
    expect(moveLayer(d, "a", "bottom")).toBe(d);
    expect(moveLayer(d, "zz", "top")).toBe(d);
  });

  it("reorder to an index", () => {
    const d = docWith("a", "b", "c");
    expect(ids(reorderLayer(d, "a", 2))).toEqual(["b", "c", "a"]);
    expect(ids(reorderLayer(d, "c", 0))).toEqual(["c", "a", "b"]);
    expect(ids(reorderLayer(d, "b", 99))).toEqual(["a", "c", "b"]);
    expect(reorderLayer(d, "b", 1)).toBe(d);
  });

  it("duplicate puts a nudged copy just above and respects the cap", () => {
    const d = docWith("a", "b");
    const { doc, id } = duplicateLayer(d, "a");
    expect(id).not.toBeNull();
    expect(ids(doc)).toEqual(["a", id, "b"]);
    const copy = findLayer(doc, id as string) as ComposerLayer;
    expect(copy.name).toBe("Text copy");
    expect(copy.x).toBeCloseTo(0.53);
    expect(copy.text).toEqual(findLayer(d, "a")?.text);
    expect(copy.text).not.toBe(findLayer(d, "a")?.text); // deep copy
    expect(duplicateLayer(d, "nope")).toEqual({ doc: d, id: null });
    const full = docWith(...Array.from({ length: MAX_LAYERS }, (_, i) => `n${i}`));
    expect(duplicateLayer(full, "n0").id).toBeNull();
  });

  it("delete, update and swap the source", () => {
    const d = docWith("a", "b");
    expect(ids(deleteLayer(d, "a"))).toEqual(["b"]);
    expect(deleteLayer(d, "zz")).toBe(d);
    expect(findLayer(updateLayer(d, "b", { hidden: true }), "b")?.hidden).toBe(true);
    expect(updateLayer(d, "zz", { hidden: true })).toBe(d);

    let img = addLayer(newComposition(), newImageLayer("/photo.jpg", 10, 10, newComposition()));
    const id = (img.layers as ComposerLayer[])[0]?.id as string;
    img = setLayerSource(img, id, "/cutout.png", "/photo.jpg");
    expect(findLayer(img, id)?.image?.ref).toEqual({ path: "/cutout.png", original: "/photo.jpg" });
    img = setLayerSource(img, id, "/photo.jpg", "");
    expect(findLayer(img, id)?.image?.ref).toEqual({ path: "/photo.jpg", original: "" });
    expect(setLayerSource(docWith("a"), "a", "/x", "")).toEqual(docWith("a"));
  });
});
