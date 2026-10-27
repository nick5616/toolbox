import { Events } from "@wailsio/runtime";
// Registers typed event payload decoding with the runtime.
import "../../bindings/events";

/** Map of app event name → payload type (generated from Go RegisterEvent calls). */
export type AppEvents = Events.CustomEvents;
export type AppEventName = keyof AppEvents;

/** Subscribe to a typed app event. Returns an unsubscribe function. */
export function on<E extends AppEventName>(name: E, cb: (data: AppEvents[E]) => void): () => void {
  return Events.On(name, (ev) => cb(ev.data as AppEvents[E]));
}
