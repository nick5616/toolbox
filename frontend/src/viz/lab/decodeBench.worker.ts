/** The decode bench inside a worker (see decodeBench.ts). */
import { benchCore, type CoreResult } from "./decodeBench";
import type { SynthStream } from "./synth";

interface Scope {
  postMessage(m: CoreResult): void;
  onmessage: ((e: MessageEvent<{ streams: Record<string, SynthStream[]> }>) => void) | null;
}
const scope = self as unknown as Scope;

scope.onmessage = (e) => {
  void benchCore(e.data.streams, "worker", () => undefined).then((r) => scope.postMessage(r));
};
