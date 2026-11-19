/**
 * RenderHost (SPEC.md §7.2): mounted once in the main window. It turns
 * `viz:render` events into a worker render and relays the worker's output to
 * Go as raw messages (no socket). It renders nothing.
 */
import { System } from "@wailsio/runtime";
import { useEffect } from "react";
import { on } from "@/lib/events";
import type { SingleDeps, SingleRun } from "./edit/headless"; // types only: the headless runner (and the effects it pulls in) loads on first use
import { announceHost } from "./edit/hostReply";
import { Sender, type HostMessage, type WorkerMessage } from "./worker/transport";

export interface Active {
  token: string;
  worker: Worker;
  sender: Sender;
}

export function startRender(token: string, planUrl: string, invoke: (msg: string) => void, active: Map<string, Active>, forceJpeg = false): void {
  const worker = new Worker(new URL("./worker/render.worker.ts", import.meta.url), { type: "module" });
  const sender = new Sender(token, invoke);
  const entry: Active = { token, worker, sender };
  active.set(token, entry);
  const finish = () => {
    worker.terminate();
    active.delete(token);
  };
  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    if (!active.has(token)) return; // the render already ended
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
    if (!active.has(token)) return;
    sender.error("The visual renderer failed", e.message);
    finish();
  };
  const msg: HostMessage = { type: "render", token, planUrl, forceJpeg };
  worker.postMessage(msg);
}

/** Headless requests in flight (compositions and recipes), by token. */
export type Singles = Map<string, SingleRun>;

/**
 * Routes a `viz:render` event: pipeline requests answered by the host itself
 * (kind "composition" or "recipe", Phase 14 A2) or a video render in a worker.
 * `kind` is absent from the generated event type until bindings are regenerated.
 */
export function routeRender(
  d: { token: string; planUrl: string; kind?: string },
  invoke: (msg: string) => void,
  active: Map<string, Active>,
  singles: Singles,
  forceJpeg = false,
  deps?: SingleDeps,
): void {
  if (d.kind === "composition" || d.kind === "recipe" || d.kind === "still") {
    const run: SingleRun = { token: d.token, abort: new AbortController() };
    singles.set(d.token, run);
    void import("./edit/headless")
      .then((m) => m.runSingle(run, d.planUrl, invoke, deps ?? m.defaultSingleDeps))
      .finally(() => singles.delete(d.token));
    return;
  }
  startRender(d.token, d.planUrl, invoke, active, forceJpeg);
}

/** Cancels whichever kind of request has this token. */
export function cancelRender(token: string, active: Map<string, Active>, singles: Singles): void {
  singles.get(token)?.abort.abort();
  active.get(token)?.worker.postMessage({ type: "cancel" } satisfies HostMessage);
}

export default function RenderHost() {
  useEffect(() => {
    const active = new Map<string, Active>();
    const singles: Singles = new Map();
    const invoke = (msg: string) => System.invoke(msg);
    const forceJpeg = new URLSearchParams(location.search).get("vizjpeg") === "1";
    const offs = [
      on("viz:render", (d) => routeRender(d as typeof d & { kind?: string }, invoke, active, singles, forceJpeg)),
      on("viz:render-cancel", (d) => cancelRender(d.token, active, singles)),
      on("viz:render-ack", (d) => active.get(d.token)?.worker.postMessage({ type: "ack", bytes: d.bytes } satisfies HostMessage)),
    ];
    // Tell Go a window can draw: pipeline steps that render headless wait for it.
    announceHost(invoke, true);
    const down = () => announceHost(invoke, false);
    window.addEventListener("pagehide", down);
    return () => {
      window.removeEventListener("pagehide", down);
      down();
      for (const off of offs) off();
      for (const a of active.values()) a.worker.terminate();
      for (const s of singles.values()) s.abort.abort();
    };
  }, []);
  return null;
}
