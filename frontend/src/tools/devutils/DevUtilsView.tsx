import { Suspense, useEffect, useState } from "react";
import { EmptyState, Icon, Spinner, TextField } from "@/components";
import { useUI } from "@/state/ui";
import { useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "../index";
import { UTILS, filterUtils, isUtilId, useDevUtilsNav, type UtilId } from "./registry";
import styles from "./DevUtils.module.css";

interface Saved {
  last: UtilId;
}

const DEFAULTS: Saved = { last: "json" };

function sanitize(saved: unknown, defaults: Saved): Saved {
  const last = typeof saved === "object" && saved !== null ? (saved as { last?: unknown }).last : undefined;
  return isUtilId(last) ? { last } : defaults;
}

export default function DevUtilsView({ moduleId }: ToolViewProps) {
  const [saved, setSaved, loaded] = useModuleOptions<Saved>(moduleId, DEFAULTS, sanitize);
  const selected = useDevUtilsNav((s) => s.selected);
  const select = useDevUtilsNav((s) => s.select);
  const [query, setQuery] = useState("");

  // A file dropped on this tool (or sent to it) belongs to the Hash utility.
  const handoff = useUI((s) => s.handoff);
  useEffect(() => {
    if (handoff?.moduleId === moduleId) select("hash");
  }, [handoff, moduleId, select]);

  const currentId: UtilId = selected ?? (loaded ? saved.last : DEFAULTS.last);
  const current = UTILS.find((u) => u.id === currentId) ?? UTILS[0]!;
  const visible = filterUtils(query);

  const choose = (id: UtilId) => {
    select(id);
    setSaved({ last: id });
  };

  // Remember a palette-selected utility too.
  useEffect(() => {
    if (loaded && selected && selected !== saved.last) setSaved({ last: selected });
  }, [loaded, selected, saved.last, setSaved]);

  const Active = current.Component;

  return (
    <section className={styles.root} aria-label="Dev Utilities">
      <nav className={styles.nav} aria-label="Utilities">
        <TextField size="sm" icon="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search utilities" aria-label="Search utilities" />
        <ul className={styles.navList}>
          {visible.map((u) => (
            <li key={u.id}>
              <button type="button" className={styles.navItem} aria-current={u.id === current.id} onClick={() => choose(u.id)}>
                <Icon name={u.icon} size={16} />
                {u.name}
              </button>
            </li>
          ))}
        </ul>
        {visible.length === 0 && <EmptyState size="md" icon="search" title="No utilities match" />}
      </nav>
      <div className={styles.main}>
        <h1 className={styles.title}>{current.name}</h1>
        <p className={styles.note}>Everything here runs on this computer. Nothing is sent anywhere.</p>
        <Suspense fallback={<Spinner />}>
          <Active key={current.id} />
        </Suspense>
      </div>
    </section>
  );
}
