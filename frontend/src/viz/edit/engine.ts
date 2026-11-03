/**
 * The Edit Studio engine (Phase 9 SPEC §8.1, §8.4). WP-ES3 implements it; the
 * public API is frozen.
 *
 * Wave 0 stub: fills the frame with the colour of the topmost active clip
 * (colour clips use their colour, others a colour hashed from the clip ID),
 * so the UI packages can run before the real renderer lands.
 */
import { createContext, type AnyCanvas } from "../gl/core";
import type { StubCompiled } from "./compile";
import type { CompiledEdit, EditEngineOptions, FrameKey, FrameProvider } from "./types";

function hashColor(id: string): [number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const hue = ((h >>> 0) % 360) / 360;
  const f = (n: number) => {
    const k = (n + hue * 12) % 12;
    return 0.5 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function hexColor(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class EditEngine {
  readonly gl: WebGL2RenderingContext;
  private opts: EditEngineOptions;
  private edit: CompiledEdit | null = null;

  constructor(
    readonly canvas: AnyCanvas,
    opts: EditEngineOptions,
  ) {
    this.opts = { ...opts };
    canvas.width = opts.width;
    canvas.height = opts.height;
    this.gl = createContext(canvas, { alpha: false, preserve: !opts.inWorker });
  }

  get options(): Readonly<EditEngineOptions> {
    return this.opts;
  }

  setEdit(c: CompiledEdit): void {
    this.edit = c;
  }

  /** The stream frames the frame at tMs (timeline ms) uses. */
  needs(tMs: number): FrameKey[] {
    void tMs;
    return [];
  }

  /** Draws and presents the frame at tMs (timeline ms). Synchronous. */
  render(tMs: number, frames: FrameProvider): void {
    void frames;
    const gl = this.gl;
    const c = this.edit as StubCompiled | null;
    let rgb: [number, number, number] = c?.background ? hexColor(c.background) : [0, 0, 0];
    for (const t of c?.tracks ?? []) {
      if (t.muted) continue;
      const clip = t.clips.find((cl) => tMs >= cl.startMs && tMs < cl.endMs && cl.kind !== "adjust");
      if (clip) rgb = clip.kind === "color" && clip.color ? hexColor(clip.color) : hashColor(clip.id);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  readPixels(): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  resize(width: number, height: number): void {
    this.opts.width = width;
    this.opts.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  dispose(): void {
    this.edit = null;
  }
}
