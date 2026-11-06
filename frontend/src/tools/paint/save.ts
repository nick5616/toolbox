/**
 * Autosave (SPEC §1.1 item 13, §2.2). Two seconds after the last change, and
 * on blur, pop-out and close:
 *   1. dirty tiles (`engine.dirtyTiles` + `encodeTile`) → `SaveTiles`, in
 *      batches of about 1 MiB;
 *   2. the document → `SaveDoc` (lists the tiles that exist, bumps `rev` of
 *      layers whose pixels changed);
 *   3. thumbnail + render → `SaveThumb` (only when pixels changed).
 * The order matters: the document is saved last so a crash never references a
 * tile that isn't on disk.
 */
import { PaintService, type PaintDoc } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { PaintEngine } from "@/paint/engine/types";

export const AUTOSAVE_MS = 2000;
export const BATCH_BYTES = 1 << 20;
export const THUMB_MAX = 512;
export const RENDER_MAX = 4096;

export type SaveStateName = "saved" | "dirty" | "saving" | "error";

export interface SaverApi {
  SaveTiles(id: string, layerID: string, tiles: Record<string, string>, removed: string[]): Promise<void>;
  SaveDoc(id: string, name: string, doc: PaintDoc): Promise<void>;
  SaveThumb(id: string, jpegDataURL: string, renderPNGDataURL: string): Promise<void>;
}

export interface SaverOptions {
  engine: PaintEngine;
  projectId: string;
  getName(): string;
  /** The guides JSON stored in the document ("" = none). */
  getGuides(): string;
  onState(state: SaveStateName, error: string): void;
  api?: SaverApi;
  thumbs?: (engine: PaintEngine) => Promise<{ jpeg: string; png: string }>;
  toDataURL?: (b: Blob) => Promise<string>;
  delayMs?: number;
  batchBytes?: number;
}

const defaultApi: SaverApi = {
  SaveTiles: (id, layerID, tiles, removed) => PaintService.SaveTiles(id, layerID, tiles, removed),
  SaveDoc: (id, name, doc) => PaintService.SaveDoc(id, name, doc),
  SaveThumb: (id, jpeg, png) => PaintService.SaveThumb(id, jpeg, png),
};

export function blobToDataURL(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Couldn't read the tile"));
    r.readAsDataURL(b);
  });
}

/** Thumbnail JPEG (≤ 512 px) and render PNG (≤ 4096 px) of the flattened canvas. */
export async function makeThumbs(engine: PaintEngine): Promise<{ jpeg: string; png: string }> {
  const { width, height, background } = engine.doc;
  const long = Math.max(width, height, 1);
  const bmp = await engine.flattenToBitmap(Math.min(1, RENDER_MAX / long));
  try {
    const full = document.createElement("canvas");
    full.width = bmp.width;
    full.height = bmp.height;
    const g = full.getContext("2d");
    if (!g) return { jpeg: "", png: "" };
    g.drawImage(bmp, 0, 0);
    const png = full.toDataURL("image/png");
    const k = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height, 1));
    const t = document.createElement("canvas");
    t.width = Math.max(1, Math.round(bmp.width * k));
    t.height = Math.max(1, Math.round(bmp.height * k));
    const tg = t.getContext("2d");
    if (!tg) return { jpeg: "", png };
    tg.fillStyle = background && background !== "transparent" ? background : "#ffffff";
    tg.fillRect(0, 0, t.width, t.height);
    tg.drawImage(full, 0, 0, t.width, t.height);
    return { jpeg: t.toDataURL("image/jpeg", 0.85), png };
  } finally {
    bmp.close();
  }
}

export class Saver {
  private opts: Required<Pick<SaverOptions, "delayMs" | "batchBytes">> & SaverOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private disposed = false;
  private tiles = new Map<string, Set<string>>();
  private revs = new Map<string, number>();
  private offs: Array<() => void> = [];
  /** How many SaveDoc calls succeeded (tests, status text). */
  saves = 0;

  constructor(opts: SaverOptions) {
    this.opts = { delayMs: AUTOSAVE_MS, batchBytes: BATCH_BYTES, ...opts };
  }

  /** Reads the loaded document's tile lists; call after the engine has loaded, then it listens for changes. */
  start(): void {
    this.disposed = false;
    this.sync();
    if (this.offs.length) return;
    const e = this.opts.engine;
    this.offs.push(e.on("change", () => this.markDirty()), e.on("layers", () => this.markDirty()));
  }

  /** Re-reads the tile lists and revisions of the engine's document (after a reload). */
  sync(): void {
    this.tiles.clear();
    this.revs.clear();
    for (const l of this.opts.engine.doc.layers ?? []) {
      this.tiles.set(l.id, new Set(l.tiles ?? []));
      this.revs.set(l.id, l.rev);
    }
  }

  markDirty(): void {
    if (this.disposed) return;
    this.opts.onState(this.running ? "saving" : "dirty", "");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => undefined), this.opts.delayMs);
    if (this.running) this.again = true;
  }

  /** Saves now (blur, close, pop-out, Export). Resolves when everything pending is on disk. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
    });
    await this.running;
    if (this.again && !this.disposed) {
      this.again = false;
      await this.flush();
    }
  }

  private async run(): Promise<void> {
    const { engine, projectId, onState } = this.opts;
    const api = this.opts.api ?? defaultApi;
    onState("saving", "");
    try {
      const dirty = engine.dirtyTiles();
      const layerIds = new Set((engine.doc.layers ?? []).map((l) => l.id));
      const changed = new Set<string>();
      for (const [layerId, keySet] of dirty) {
        const keys = [...keySet].sort();
        if (!layerIds.has(layerId)) {
          engine.markSaved(layerId, keys);
          continue;
        }
        const toData = this.opts.toDataURL ?? blobToDataURL;
        let batch: Record<string, string> = {};
        let removed: string[] = [];
        let bytes = 0;
        let batchKeys: string[] = [];
        const send = async () => {
          if (batchKeys.length === 0) return;
          await api.SaveTiles(projectId, layerId, batch, removed);
          const set = this.tiles.get(layerId) ?? new Set<string>();
          for (const k of Object.keys(batch)) set.add(k);
          for (const k of removed) set.delete(k);
          this.tiles.set(layerId, set);
          engine.markSaved(layerId, batchKeys);
          changed.add(layerId);
          batch = {};
          removed = [];
          bytes = 0;
          batchKeys = [];
        };
        for (const key of keys) {
          const blob = await engine.encodeTile(layerId, key);
          if (blob) {
            const url = await toData(blob);
            if (bytes > 0 && bytes + url.length > this.opts.batchBytes) await send();
            batch[key] = url;
            bytes += url.length;
          } else removed.push(key);
          batchKeys.push(key);
        }
        await send();
      }
      const doc: PaintDoc = {
        ...engine.doc,
        guides: this.opts.getGuides(),
        layers: (engine.doc.layers ?? []).map((l) => {
          const rev = (this.revs.get(l.id) ?? l.rev) + (changed.has(l.id) ? 1 : 0);
          this.revs.set(l.id, rev);
          return { ...l, tiles: [...(this.tiles.get(l.id) ?? new Set<string>())].sort(), rev };
        }),
      };
      await api.SaveDoc(projectId, this.opts.getName(), doc);
      this.saves++;
      if (changed.size > 0) {
        const t = await (this.opts.thumbs ?? makeThumbs)(engine);
        if (t.jpeg || t.png) await api.SaveThumb(projectId, t.jpeg, t.png);
      }
      onState(this.again || this.timer ? "dirty" : "saved", "");
    } catch (e) {
      onState("error", toAppError(e).message);
      throw e;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.offs.forEach((o) => o());
    this.offs = [];
  }
}
