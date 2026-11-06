import { describe, expect, it } from "vitest";
import { RED, BLUE, line, strokeLine, testBrush, testEngine, rawCodec } from "../engine/testing";
import type { ToolState } from "../engine/types";
import { crc32, readZip, writeZip } from "./zip";
import { layerOnCanvas, oraFromEngine, readOra, writeOra } from "./ora";

const brush = (color = RED): ToolState => ({ kind: "brush", brush: testBrush({ size: 10 }), color, secondary: color, seed: 1 });

describe("zip", () => {
  it("round-trips stored entries and checks the directory", async () => {
    const z = writeZip([
      { name: "a.txt", data: new TextEncoder().encode("hello") },
      { name: "d/b.bin", data: new Uint8Array([1, 2, 3]) },
    ]);
    const m = await readZip(z);
    expect(new TextDecoder().decode(m.get("a.txt"))).toBe("hello");
    expect(Array.from(m.get("d/b.bin")!)).toEqual([1, 2, 3]);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    await expect(readZip(new Uint8Array(30))).rejects.toThrow();
  });
});

describe("ora", () => {
  it("round-trips layers, properties and pixels", async () => {
    const e = await testEngine(48, 32, {}, "#ffffff");
    strokeLine(e, brush(), line(5, 8, 40, 8));
    const top = e.addLayer({ name: "Ink", blend: "multiply", opacity: 0.6, clip: true });
    e.setLayer(top, { alphaLock: false });
    strokeLine(e, brush(BLUE), line(5, 24, 40, 24));
    e.setLayer(top, { hidden: true, locked: true, reference: true });
    const doc = oraFromEngine(e);
    const bytes = await writeOra(doc, rawCodec);

    // The container is a valid ORA: mimetype first and stored.
    expect(new TextDecoder().decode(bytes.subarray(30, 30 + 8))).toBe("mimetype");
    const files = await readZip(bytes);
    expect([...files.keys()]).toEqual(expect.arrayContaining(["mimetype", "stack.xml", "mergedimage.png", "Thumbnails/thumbnail.png"]));
    expect(new TextDecoder().decode(files.get("stack.xml")!)).toContain('composite-op="svg:multiply"');

    const back = await readOra(bytes, rawCodec);
    expect(back.width).toBe(48);
    expect(back.height).toBe(32);
    expect(back.layers).toHaveLength(2);
    const [bottom, ink] = back.layers;
    expect(bottom!.blend).toBe("normal");
    expect(ink).toMatchObject({ name: "Ink", blend: "multiply", hidden: true, locked: true, reference: true, clip: true });
    expect(ink!.opacity).toBeCloseTo(0.6, 3);
    for (let i = 0; i < doc.layers.length; i++) expect(Array.from(back.layers[i]!.image.data)).toEqual(Array.from(doc.layers[i]!.image.data));
    expect(Array.from(back.merged!.data)).toEqual(Array.from(doc.merged!.data));
  });

  it("maps every blend mode to a composite-op and back", async () => {
    const e = await testEngine(8, 8);
    const modes = ["normal", "multiply", "screen", "overlay", "add", "darken", "lighten", "color-dodge", "color-burn", "soft-light", "hard-light", "difference", "hue", "saturation", "color", "luminosity"];
    for (const m of modes) e.addLayer({ blend: m });
    const back = await readOra(await writeOra(oraFromEngine(e), rawCodec), rawCodec);
    expect(back.layers.slice(1).map((l) => l.blend)).toEqual(modes);
  });

  it("places offset layers on the canvas and rejects junk", async () => {
    const l = { name: "x", hidden: false, locked: false, alphaLock: false, clip: false, reference: false, opacity: 1, blend: "normal", x: 2, y: 1, image: { data: new Uint8ClampedArray(4).fill(255), width: 1, height: 1 } };
    const full = layerOnCanvas(l, 4, 3);
    expect(Array.from(full.data.subarray((1 * 4 + 2) * 4, (1 * 4 + 2) * 4 + 4))).toEqual([255, 255, 255, 255]);
    await expect(readOra(writeZip([{ name: "x", data: new Uint8Array(1) }]), rawCodec)).rejects.toThrow(/stack.xml/);
  });
});
