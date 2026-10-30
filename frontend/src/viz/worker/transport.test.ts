import { describe, expect, it } from "vitest";
import { BATCH_BYTES, Batcher, FlowControl, MAX_IN_FLIGHT, Sender, toBase64 } from "./transport";

describe("Batcher", () => {
  it("packs chunks into batches of at most 2 MiB and keeps every byte in order", () => {
    const out: Uint8Array[] = [];
    const b = new Batcher((buf) => out.push(buf));
    for (let i = 0; i < 40; i++) b.push(new Uint8Array(300_000).fill(i + 1));
    b.push(new Uint8Array(5 * BATCH_BYTES + 10).fill(99));
    b.flush();
    expect(out.every((o) => o.length <= BATCH_BYTES)).toBe(true);
    expect(out.reduce((n, o) => n + o.length, 0)).toBe(40 * 300_000 + 5 * BATCH_BYTES + 10);
    expect(out[0]?.[0]).toBe(1);
    expect(out[out.length - 1]?.[0]).toBe(99);
  });
  it("flush on empty sends nothing", () => {
    const out: Uint8Array[] = [];
    new Batcher((b) => out.push(b)).flush();
    expect(out).toHaveLength(0);
  });
});

describe("Sender", () => {
  it("formats messages and numbers data from zero", () => {
    const sent: string[] = [];
    const s = new Sender("tok", (m) => sent.push(m));
    s.start({ encoder: "jpeg", width: 4, height: 2, fps: 30, frames: 3 });
    s.data(new Uint8Array([1, 2, 3]));
    s.data(new Uint8Array([4]));
    s.progress(15, 30);
    s.done(3);
    s.cancelled();
    s.error("m", "d");
    expect(sent[0]).toBe('vz1|tok|start|{"encoder":"jpeg","width":4,"height":2,"fps":30,"frames":3}');
    expect(sent[1]).toBe("vz1|tok|data|0|AQID");
    expect(sent[2]).toBe("vz1|tok|data|1|BA==");
    expect(sent[3]).toBe("vz1|tok|progress|15|30");
    expect(sent[4]).toBe('vz1|tok|done|{"frames":3,"bytes":4}');
    expect(sent[5]).toBe("vz1|tok|cancelled");
    expect(sent[6]).toBe('vz1|tok|error|{"message":"m","detail":"d"}');
  });
});

describe("toBase64", () => {
  it("the btoa fallback equals the native result", () => {
    const u8 = new Uint8Array(100_000);
    for (let i = 0; i < u8.length; i++) u8[i] = (i * 31) & 255;
    const proto = Uint8Array.prototype as unknown as { toBase64?: () => string };
    const native = proto.toBase64;
    delete proto.toBase64;
    const fallback = toBase64(u8);
    proto.toBase64 = function (this: Uint8Array) {
      let s = "";
      for (const b of this) s += String.fromCharCode(b);
      return btoa(s);
    };
    try {
      expect(toBase64(u8)).toBe(fallback);
      expect(fallback.length).toBe(Math.ceil(u8.length / 3) * 4);
    } finally {
      if (native) proto.toBase64 = native;
      else delete proto.toBase64;
    }
  });
});

describe("FlowControl", () => {
  it("waits while more than the window is unacknowledged and resumes on ack", async () => {
    const f = new FlowControl();
    f.addSent(MAX_IN_FLIGHT + 1);
    let resumed = false;
    const p = f.waitWindow().then(() => (resumed = true));
    await Promise.resolve();
    expect(resumed).toBe(false);
    f.ack(1);
    await p;
    expect(resumed).toBe(true);
  });
  it("does not wait within the window and ignores stale acks", async () => {
    const f = new FlowControl();
    f.addSent(MAX_IN_FLIGHT);
    await f.waitWindow();
    f.ack(100);
    f.ack(50);
    expect(f.acked).toBe(100);
  });
  it("cancel releases waiters", async () => {
    const f = new FlowControl();
    f.addSent(MAX_IN_FLIGHT * 2);
    const p = f.waitWindow();
    f.cancel();
    await p;
    expect(f.cancelled).toBe(true);
  });
});
