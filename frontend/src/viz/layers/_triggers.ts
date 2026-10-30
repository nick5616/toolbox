/**
 * Event sources for accent layers (ripples, shockwave, sweep): kick, snare,
 * beat, downbeat, drop, word, section and the other instruments, as sorted
 * [ms, strength 0..255] lists cached per analysis.
 */
import type { Analysis, Event2 } from "../analysis";

export const TRIGGER_OPTIONS = ["kick", "snare", "hats", "beat", "downbeat", "drop", "word", "section", "bass", "vocals", "other"] as const;

const cache = new WeakMap<Analysis, Map<string, readonly Event2[]>>();

function build(a: Analysis, src: string): Event2[] {
  const times = (arr: number[], s = 255): Event2[] => arr.map((t) => [t, s] as Event2);
  switch (src) {
    case "beat":
      return times(a.audio.beats, 200);
    case "downbeat":
      return times(a.audio.downbeats);
    case "word":
      return a.allWords().map((w) => [w.startMs, w.emphasis ? 255 : 170] as Event2);
    case "section":
      return times(a.audio.sections.map((s) => s.startMs));
    case "kick": {
      const k = a.events("kick");
      return [...(k.length > 0 ? k : a.events("mix"))];
    }
    case "drop+downbeat": {
      const out = [...a.events("drop"), ...a.audio.downbeats.map((t) => [t, 110] as Event2)];
      return out.sort((x, y) => x[0] - y[0]);
    }
    default:
      return [...a.events(src)];
  }
}

/** The sorted event list for a source; `every` keeps each n-th event. */
export function triggerList(a: Analysis, src: string, every = 1): readonly Event2[] {
  let m = cache.get(a);
  if (!m) {
    m = new Map();
    cache.set(a, m);
  }
  const key = `${src}/${every}`;
  let list = m.get(key);
  if (!list) {
    const full = build(a, src);
    list = every <= 1 ? full : full.filter((_, i) => i % every === 0);
    m.set(key, list);
  }
  return list;
}

/** Events with t0 < ms <= t1 from a sorted list. */
export function eventsIn(list: readonly Event2[], t0: number, t1: number): Event2[] {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as Event2)[0] <= t0) lo = mid + 1;
    else hi = mid;
  }
  const out: Event2[] = [];
  for (let i = lo; i < list.length; i++) {
    const e = list[i] as Event2;
    if (e[0] > t1) break;
    out.push(e);
  }
  return out;
}
