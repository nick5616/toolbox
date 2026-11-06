/**
 * Custom drop targets (Phase 13): a view can claim drops on elements whose id
 * starts with a prefix (Local File Transfer's device rows, `lan-device:<fp>`).
 * The shell's drop routing (OS drops and in-app drags alike) asks here first,
 * so a claimed drop never also reaches the tool on screen or the chooser.
 */
type Handler = (rest: string, paths: string[]) => void;

const handlers = new Map<string, Handler>();

/** Claims drops on `[id^=prefix]`; returns the unregister function. The latest registration of a prefix wins. */
export function registerDropTarget(prefix: string, handler: Handler): () => void {
  handlers.set(prefix, handler);
  return () => {
    if (handlers.get(prefix) === handler) handlers.delete(prefix);
  };
}

/** Whether a custom target owns this target id (in-app drops skip the match lookup for these). */
export function isCustomDropTarget(targetId: string): boolean {
  for (const prefix of handlers.keys()) if (targetId.startsWith(prefix)) return true;
  return false;
}

/** Hands a drop to its custom target; true when one took it. */
export function routeCustomDrop(targetId: string, paths: string[]): boolean {
  for (const [prefix, h] of handlers) {
    if (targetId.startsWith(prefix)) {
      h(targetId.slice(prefix.length), paths);
      return true;
    }
  }
  return false;
}
