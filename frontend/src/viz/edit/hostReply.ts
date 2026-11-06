/**
 * Replies of the render host's headless requests (Phase 14 A2): one file (a
 * PNG/JPEG still or a JSON document) sent to Go as `vz1|<token>|…` raw
 * messages. The same protocol and token rules as video renders; the broker
 * checks the encoder against its plan.
 */
import { RAW_PREFIX, toBase64 } from "../worker/transport";

/** Bytes per `data` message (before base64). */
export const CHUNK_BYTES = 1024 * 1024;

export type SingleEncoder = "png" | "jpg" | "json";

export class SingleReply {
  private seq = 0;
  private bytes = 0;
  constructor(
    readonly token: string,
    private readonly invoke: (msg: string) => void,
  ) {}

  private send(kind: string, ...parts: Array<string | number>): void {
    this.invoke([RAW_PREFIX + this.token, kind, ...parts.map(String)].join("|"));
  }
  start(encoder: SingleEncoder, width: number, height: number): void {
    this.send("start", JSON.stringify({ encoder, width, height, fps: 1, frames: 1 }));
  }
  progress(done: number, total: number): void {
    this.send("progress", done, total);
  }
  /** Sends the whole file, then `done`. */
  file(data: Uint8Array): void {
    for (let i = 0; i < data.length; i += CHUNK_BYTES) {
      const part = data.subarray(i, i + CHUNK_BYTES);
      this.bytes += part.length;
      this.send("data", this.seq++, toBase64(part));
    }
    this.send("done", JSON.stringify({ frames: 1, bytes: this.bytes }));
  }
  error(message: string, detail = ""): void {
    this.send("error", JSON.stringify({ message, detail }));
  }
  cancelled(): void {
    this.send("cancelled");
  }
}

/** Tells Go the render host is mounted (steps that draw headless wait for it). */
export function announceHost(invoke: (msg: string) => void, up: boolean): void {
  invoke(`${RAW_PREFIX}host|${up ? "up" : "down"}`);
}
