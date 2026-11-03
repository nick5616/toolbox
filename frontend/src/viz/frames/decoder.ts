/**
 * One WebCodecs VideoDecoder per stream (Phase 9 SPEC §8.2).
 *
 * Streams are Annex-B H.264 with no B-frames, so output order is decode order
 * and `configure` takes no description. To get frame n the decoder starts at
 * the key frame at or before n, or continues from its last fed frame when n is
 * ahead by at most two GOPs; outputs that nobody wants are closed at once.
 * Every VideoFrame it receives is either handed to `accept` (which owns it from
 * then on) or closed here, exactly once.
 */
import { chooseStart } from "./gop";
import type { StreamBytes } from "./source";
import type { StreamIndex } from "./types";

/** The slice of VideoDecoder this module uses (fakes implement it in tests). */
export interface VideoDecoderLike {
  readonly state: string;
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

export interface DecoderEnv {
  createDecoder(init: { output: (frame: VideoFrame) => void; error: (e: Error) => void }): VideoDecoderLike;
  createChunk(type: "key" | "delta", timestamp: number, data: Uint8Array): EncodedVideoChunk;
}

/** The browser's real WebCodecs. */
export const REAL_ENV: DecoderEnv = {
  createDecoder: (init) => new VideoDecoder({ output: init.output, error: (e) => init.error(e instanceof Error ? e : new Error(String(e))) }),
  createChunk: (type, timestamp, data) => new EncodedVideoChunk({ type, timestamp, data }),
};

export function hasVideoDecoder(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
}

/** Timestamps carry (epoch, frame): outputs of a decoder generation that was reset are recognised and closed. */
export const EPOCH_SPAN = 1 << 22;

/** Decode through gaps of this many frames rather than resetting. */
const GAP = 12;
/** Longest run fed without re-checking what's wanted. */
const MAX_RUN = 60;
const QUEUE_HIGH = 4;
/** After the queue drains and a wanted frame is still missing, flush (a decoder that buffers). */
const STALL_MS = 250;
const MAX_FAILURES = 3;

export interface StreamDecoderOptions {
  key: string;
  index: StreamIndex;
  bytes: Pick<StreamBytes, "ensure" | "au">;
  env: DecoderEnv;
  /** Frames still wanted and not resident (a live computation; may change at any time). */
  wants(): ReadonlySet<number>;
  /** Takes ownership of a wanted frame. */
  accept(frame: number, image: VideoFrame): void;
  /** A decode failure (the decoder is rebuilt on the next kick, up to a few times). */
  onError(e: Error): void;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class StreamDecoder {
  private decoder: VideoDecoderLike | null = null;
  private epoch = 0;
  private lastFed = -1;
  private running = false;
  private dirty = false;
  private disposed = false;
  private failures = 0;
  private waiter: { n: number; done: () => void; fail: (e: Error) => void } | null = null;
  /** Decode runs started (tests). */
  runs = 0;
  /** Decoder resets (tests, Edit Lab). */
  resets = 0;

  constructor(private readonly o: StreamDecoderOptions) {}

  get position(): number {
    return this.lastFed;
  }

  get failed(): boolean {
    return this.failures >= MAX_FAILURES;
  }

  /** Something changed (new wants): (re)start the pump if idle. */
  kick(): void {
    if (this.disposed || this.failed) return;
    this.dirty = true;
    if (this.running) return;
    this.running = true;
    void this.pump().finally(() => {
      this.running = false;
      if (this.dirty && !this.disposed) this.kick();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.waiter?.done();
    this.waiter = null;
    const d = this.decoder;
    this.decoder = null;
    if (d && d.state !== "closed") {
      try {
        d.close();
      } catch {
        // already closed
      }
    }
  }

  private async pump(): Promise<void> {
    let stuck = 0;
    for (;;) {
      this.dirty = false;
      if (this.disposed || this.failed) return;
      const wanted = [...this.o.wants()].sort((a, b) => a - b);
      const target = wanted[0];
      if (target === undefined) return;
      const { start, reset } = chooseStart(this.o.index.keys, target, this.lastFed);
      let end = target;
      for (const w of wanted.slice(1)) {
        if (w - end <= GAP && w - start < MAX_RUN) end = w;
        else break;
      }
      try {
        await this.run(start, end, reset);
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (this.o.wants().has(target)) {
        // The run finished without delivering the frame (a stale epoch, or a decoder that dropped it).
        if (++stuck >= 3) {
          this.fail(new Error(`Frame ${target} didn't come out of the decoder`));
          return;
        }
        this.lastFed = -1;
      } else stuck = 0;
    }
  }

  private fail(e: Error): void {
    this.failures++;
    this.lastFed = -1;
    const d = this.decoder;
    this.decoder = null;
    if (d && d.state !== "closed") {
      try {
        d.close();
      } catch {
        // ignore
      }
    }
    this.waiter?.done();
    this.waiter = null;
    this.o.onError(e);
  }

  private ensureDecoder(reset: boolean): void {
    if (this.decoder && this.decoder.state !== "closed" && !reset) return;
    this.epoch++;
    this.resets++;
    this.lastFed = -1;
    const cfg: VideoDecoderConfig = { codec: this.o.index.codec, codedWidth: this.o.index.width, codedHeight: this.o.index.height, optimizeForLatency: true };
    if (this.decoder && this.decoder.state !== "closed") {
      this.decoder.reset();
    } else {
      this.decoder = this.o.env.createDecoder({ output: (f) => this.onOutput(f), error: (e) => this.onDecoderError(e) });
    }
    (this.decoder as VideoDecoderLike).configure(cfg);
  }

  private onDecoderError(e: Error): void {
    if (this.disposed) return;
    this.fail(e);
  }

  private onOutput(frame: VideoFrame): void {
    const ts = frame.timestamp;
    const ep = Math.floor(ts / EPOCH_SPAN);
    const n = ts - ep * EPOCH_SPAN;
    if (this.disposed || ep !== this.epoch) {
      frame.close();
      return;
    }
    if (this.o.wants().has(n)) this.o.accept(n, frame);
    else frame.close();
    const w = this.waiter;
    if (w && n >= w.n) w.done();
  }

  private anyWanted(from: number, to: number): boolean {
    for (const w of this.o.wants()) if (w >= from && w <= to) return true;
    return false;
  }

  private async run(start: number, end: number, reset: boolean): Promise<void> {
    this.runs++;
    this.ensureDecoder(reset || start === this.o.index.keys[0] || this.lastFed < 0);
    const epoch = this.epoch;
    await this.o.bytes.ensure(start, end);
    let lastWanted = -1;
    for (let i = start; i <= end; i++) {
      if (this.disposed || this.epoch !== epoch || !this.decoder) return;
      if (!this.anyWanted(i, end)) break; // the wants moved on
      let au = this.o.bytes.au(i);
      if (!au) {
        await this.o.bytes.ensure(i, end);
        au = this.o.bytes.au(i);
        if (!au) throw new Error(`The bytes of frame ${i} are missing`);
      }
      const isKey = this.isKey(i);
      this.decoder.decode(this.o.env.createChunk(isKey ? "key" : "delta", epoch * EPOCH_SPAN + i, au));
      this.lastFed = i;
      if (this.o.wants().has(i)) lastWanted = i;
      while (this.decoder && this.decoder.decodeQueueSize > QUEUE_HIGH && !this.disposed && this.epoch === epoch) await tick();
    }
    if (lastWanted >= 0) await this.waitFor(lastWanted, epoch);
  }

  private keySet: Set<number> | null = null;
  private isKey(n: number): boolean {
    this.keySet ??= new Set(this.o.index.keys);
    return this.keySet.has(n);
  }

  /** Resolves once the output for frame n (or later) arrived; flushes a decoder that sits on its frames. */
  private waitFor(n: number, epoch: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        if (this.waiter === w) this.waiter = null;
        resolve();
      };
      const w = { n, done, fail: () => done() };
      this.waiter = w;
      const arm = () => {
        timer = setTimeout(() => {
          const d = this.decoder;
          if (this.waiter !== w || !d || this.epoch !== epoch || this.disposed) return done();
          if (d.decodeQueueSize > 0) return arm();
          d.flush().then(
            () => {
              this.lastFed = -1; // a flushed decoder wants a key frame next
              done();
            },
            () => done(),
          );
        }, STALL_MS);
      };
      arm();
    });
  }
}
