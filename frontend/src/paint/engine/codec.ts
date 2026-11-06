// PNG and bitmap conversion, injected so vitest (no canvas in jsdom) can swap
// in a fake. The default uses OffscreenCanvas / a canvas element.

export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PngCodec {
  /** Straight RGBA → PNG bytes. */
  encode(img: RawImage): Promise<Uint8Array>;
  /** PNG bytes → straight RGBA. */
  decode(bytes: Uint8Array): Promise<RawImage>;
  /** A decoded tile bitmap → straight RGBA. */
  fromBitmap(b: ImageBitmap): RawImage;
  /** Straight RGBA → bitmap (flattened exports). */
  toBitmap(img: RawImage): Promise<ImageBitmap>;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function canvas2d(w: number, h: number): { ctx: Ctx2D; toBytes: () => Promise<Uint8Array> } {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    return { ctx, toBytes: async () => new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()) };
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  return {
    ctx,
    toBytes: () =>
      new Promise((res, rej) =>
        c.toBlob((b) => (b ? b.arrayBuffer().then((a) => res(new Uint8Array(a)), rej) : rej(new Error("toBlob failed"))), "image/png"),
      ),
  };
}

export function browserCodec(): PngCodec {
  const toImageData = (img: RawImage): ImageData => new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height);
  return {
    async encode(img) {
      const { ctx, toBytes } = canvas2d(img.width, img.height);
      ctx.putImageData(toImageData(img), 0, 0);
      return toBytes();
    },
    async decode(bytes) {
      const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }), { premultiplyAlpha: "none" });
      const r = this.fromBitmap(bmp);
      bmp.close();
      return r;
    },
    fromBitmap(b) {
      const { ctx } = canvas2d(b.width, b.height);
      ctx.drawImage(b, 0, 0);
      const d = ctx.getImageData(0, 0, b.width, b.height);
      return { data: d.data, width: d.width, height: d.height };
    },
    async toBitmap(img) {
      return createImageBitmap(toImageData(img));
    },
  };
}
