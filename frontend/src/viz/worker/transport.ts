/**
 * The render transport (SPEC.md §7.2): worker ↔ main-thread messages and the
 * raw messages the main thread sends to Go (`vz1|<token>|<kind>|…`).
 * Pure: the main thread passes its `invoke` (Wails System.invoke).
 */

export const RAW_PREFIX = "vz1|";
export const BATCH_BYTES = 2 * 1024 * 1024;
export const MAX_IN_FLIGHT = 16 * 1024 * 1024;

export interface StartInfo {
  encoder: "h264-hw" | "h264-sw" | "jpeg";
  width: number;
  height: number;
  fps: number;
  frames: number;
}

/** Worker → main thread. */
export type WorkerMessage =
  | { type: "start"; info: StartInfo }
  | { type: "data"; buf: ArrayBuffer }
  | { type: "progress"; frame: number; frames: number }
  | { type: "done"; frames: number; bytes: number }
  | { type: "cancelled" }
  | { type: "error"; message: string; detail: string };

/** Main thread → worker. */
export type HostMessage = { type: "render"; token: string; planUrl: string } | { type: "cancel" } | { type: "ack"; bytes: number };

/** base64 of bytes: native when available, else chunked btoa. */
export function toBase64(u8: Uint8Array): string {
  const native = (u8 as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(u8);
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(s);
}

/** Builds and sends the raw messages of one render, numbering data in order. */
export class Sender {
  private seq = 0;
  bytes = 0;
  constructor(
    private readonly token: string,
    private readonly invoke: (msg: string) => void,
  ) {}

  private send(kind: string, ...parts: Array<string | number>): void {
    this.invoke([RAW_PREFIX + this.token, kind, ...parts.map(String)].join("|"));
  }
  start(info: StartInfo): void {
    this.send("start", JSON.stringify(info));
  }
  data(buf: Uint8Array): void {
    this.bytes += buf.length;
    this.send("data", this.seq++, toBase64(buf));
  }
  progress(frame: number, frames: number): void {
    this.send("progress", frame, frames);
  }
  done(frames: number): void {
    this.send("done", JSON.stringify({ frames, bytes: this.bytes }));
  }
  cancelled(): void {
    this.send("cancelled");
  }
  error(message: string, detail: string): void {
    this.send("error", JSON.stringify({ message, detail }));
  }
}

/** Packs encoded chunks into batches of at most BATCH_BYTES. */
export class Batcher {
  private parts: Uint8Array[] = [];
  private size = 0;
  constructor(private readonly flushTo: (buf: Uint8Array) => void) {}

  push(chunk: Uint8Array): void {
    if (this.size + chunk.length > BATCH_BYTES && this.size > 0) this.flush();
    if (chunk.length >= BATCH_BYTES) {
      for (let o = 0; o < chunk.length; o += BATCH_BYTES) this.flushTo(chunk.subarray(o, Math.min(chunk.length, o + BATCH_BYTES)));
      return;
    }
    this.parts.push(chunk);
    this.size += chunk.length;
  }
  flush(): void {
    if (this.size === 0) return;
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    this.parts = [];
    this.size = 0;
    this.flushTo(out);
  }
}
