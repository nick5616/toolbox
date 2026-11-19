import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Spinner } from "@/components";
import type { LabelCount } from "@/lib/api";
import { useSearch } from "@/state/search";
import { ItemThumb } from "./previews/ItemThumb";
import { fromPath } from "./items";
import { SearchGate, SearchStatusLine } from "./SearchStatusLine";
import styles from "./Search.module.css";

/** Display order of the Things sections; "" is the user's own labels. */
export const THINGS_SECTIONS: { id: string; title: string }[] = [
  { id: "", title: "Your labels" },
  { id: "people", title: "People & events" },
  { id: "animals", title: "Animals" },
  { id: "food", title: "Food & drink" },
  { id: "nature", title: "Nature & places" },
  { id: "things", title: "Things" },
  { id: "vehicles", title: "Vehicles" },
  { id: "documents", title: "Documents & screens" },
  { id: "art", title: "Art & design" },
];

export interface ThingsSection {
  id: string;
  title: string;
  labels: LabelCount[];
}

/** Groups labels into the sections in order: the user's own first, then the eight categories (unknown ones join "Things"). Empty sections are dropped. */
export function groupThings(things: readonly LabelCount[]): ThingsSection[] {
  const known = new Set(THINGS_SECTIONS.map((s) => s.id));
  const by = new Map<string, LabelCount[]>();
  for (const l of things) {
    const id = l.user ? "" : known.has(l.category) && l.category !== "" ? l.category : "things";
    const arr = by.get(id);
    if (arr) arr.push(l);
    else by.set(id, [l]);
  }
  return THINGS_SECTIONS.map((s) => ({ ...s, labels: (by.get(s.id) ?? []).slice().sort((a, b) => b.count - a.count || a.display.localeCompare(b.display)) })).filter((s) => s.labels.length > 0);
}

/** Cards in one windowed chunk, and how many cards make the view windowed at all. */
export const CHUNK = 60;
export const VIRTUALISE_ABOVE = 300;

function Chunk({ windowed, children }: { windowed: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const height = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!windowed || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setVisible(true);
          else {
            height.current = Math.max(height.current, el.offsetHeight);
            setVisible(false);
          }
        }
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [windowed]);
  return (
    <div ref={ref} data-chunk style={!visible ? { minHeight: height.current } : undefined}>
      {visible ? <div className={styles.thingsGrid}>{children}</div> : null}
    </div>
  );
}

function ThingCard({ label, onOpen }: { label: LabelCount; onOpen: (l: LabelCount) => void }) {
  return (
    <button type="button" className={styles.thing} aria-label={`${label.display}, ${label.count} files`} data-tip={`Show the ${label.count} files labelled "${label.display}"`} onClick={() => onOpen(label)}>
      <span className={styles.thingCover}>{label.cover ? <ItemThumb item={fromPath(label.cover)} /> : null}</span>
      <span className={styles.thingBody}>
        <span className={styles.thingName}>{label.display}</span>
        <span className={styles.thingCount}>{label.count}</span>
      </span>
    </button>
  );
}

/** The fifth Library view: everything the index recognised, by category. A click shows that label's files in the Grid. */
export function ThingsView({ onOpen }: { onOpen: (l: LabelCount) => void }) {
  const things = useSearch((s) => s.things);
  const loading = useSearch((s) => s.thingsLoading);
  const status = useSearch((s) => s.status);
  const version = useSearch((s) => s.indexedVersion);
  useEffect(() => {
    void useSearch.getState().loadThings().catch(() => undefined);
  }, [version, status.installed]);
  const sections = useMemo(() => groupThings(things ?? []), [things]);
  const total = (things ?? []).length;

  if (things === null && loading) {
    return (
      <div className={styles.things} aria-busy="true">
        <Spinner />
      </div>
    );
  }
  if (total === 0) {
    return (
      <EmptyState
        icon="scan-eye"
        size="lg"
        title={status.installed ? "Nothing recognised yet" : "Things appear once pictures are indexed"}
        body={status.installed ? "Labels show up here as your pictures are indexed." : undefined}
        action={status.installed ? <SearchStatusLine block /> : <SearchGate />}
      />
    );
  }
  const windowed = total > VIRTUALISE_ABOVE;
  return (
    <div className={styles.things} data-testid="things" data-windowed={windowed ? "true" : undefined}>
      {sections.map((s) => (
        <section key={s.id || "user"} aria-label={s.title}>
          <h3 className={styles.thingsHead}>{s.title}</h3>
          {Array.from({ length: Math.ceil(s.labels.length / CHUNK) }, (_, i) => (
            <Chunk key={i} windowed={windowed}>
              {s.labels.slice(i * CHUNK, (i + 1) * CHUNK).map((l) => (
                <ThingCard key={`${l.user ? "u" : "v"}:${l.label}`} label={l} onOpen={onOpen} />
              ))}
            </Chunk>
          ))}
        </section>
      ))}
    </div>
  );
}
