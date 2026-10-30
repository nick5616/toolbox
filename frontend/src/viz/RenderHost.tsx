/**
 * RenderHost (SPEC.md §7.2): mounted once in the main window. It turns
 * `viz:render` events into a worker render and relays the worker's output to
 * Go as raw messages (no socket). It renders nothing.
 */
import { System } from "@wailsio/runtime";
import { useEffect } from "react";
import { on } from "@/lib/events";
import { Sender, type HostMessage, type WorkerMessage } from "./worker/transport";

interface Active {
  token: string;
  worker: Worker;
  sender: Sender;
}

export function startRender(token: string, planUrl: string, invoke: (msg: string) => void, active: Map<string, Active>): void {
  const worker = new Worker(new URL("./worker/render.worker.ts", import.meta.url), { type: "module" });
  const sender = new Sender(token, invoke);
  const entry: Active = { token, worker, sender };
  active.set(token, entry);
  const finish = () => {
    worker.terminate();
    active.delete(token);
  };
  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const m = e.data;
    switch (m.type) {
      case "start":
        sender.start(m.info);
        break;
      case "data":
        sender.data(new Uint8Array(m.buf));
        break;
      case "progress":
        sender.progress(m.frame, m.frames);
        break;
      case "done":
        sender.done(m.frames);
        finish();
        break;
      case "cancelled":
        sender.cancelled();
        finish();
        break;
      case "error":
        sender.error(m.message, m.detail);
        finish();
        break;
    }
  };
  worker.onerror = (e) => {
    sender.error("The visual renderer failed", e.message);
    finish();
  };
  const msg: HostMessage = { type: "render", token, planUrl };
  worker.postMessage(msg);
}

export default function RenderHost() {
  useEffect(() => {
    const active = new Map<string, Active>();
    const invoke = (msg: string) => System.invoke(msg);
    const offs = [
      on("viz:render", (d) => startRender(d.token, d.planUrl, invoke, active)),
      on("viz:render-cancel", (d) => active.get(d.token)?.worker.postMessage({ type: "cancel" } satisfies HostMessage)),
      on("viz:render-ack", (d) => active.get(d.token)?.worker.postMessage({ type: "ack", bytes: d.bytes } satisfies HostMessage)),
    ];
    return () => {
      for (const off of offs) off();
      for (const a of active.values()) a.worker.terminate();
    };
  }, []);
  return null;
}
