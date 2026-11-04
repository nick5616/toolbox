import { Suspense, useEffect, useState } from "react";
import { ClickIn, ClickInHost, EmptyState, Icon, Spinner, TextField } from "@/components";
import { useClickIn } from "@/components/ClickIn";
import { useUI } from "@/state/ui";
import { useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "../index";
import { UTILS, UTIL_TIPS, filterUtils, isUtilId, useDevUtilsNav, type UtilId } from "./registry";
import styles from "./DevUtils.module.css";

interface Saved {
  last: UtilId;
}

const DEFAULTS: Saved = { last: "json" };

function sanitize(saved: unknown, defaults: Saved): Saved {
  const last = typeof saved === "object" && saved !== null ? (saved as { last?: unknown }).last : undefined;
  return isUtilId(last) ? { last } : defaults;
}

/** The utility list, inside the picker drawer: search + one button per utility; choosing one closes it. */
function PickerList({ currentId, onChoose }: { currentId: UtilId; onChoose: (id: UtilId) => void }) {
  const [query, setQuery] = useState("");
  const { close } = useClickIn();
  const visible = filterUtils(query);
  return (
    <div className={styles.picker}>
      <TextField size="sm" icon="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search utilities" aria-label="Search utilities" data-tip="Filter by name or keyword, e.g. sha, epoch, yaml" />
      <ul className={styles.navList}>
        {visible.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              className={styles.navItem}
              aria-current={u.id === currentId}
              data-tip={UTIL_TIPS[u.id]}
              onClick={() => {
                onChoose(u.id);
                close();
              }}
            >
              <Icon name={u.icon} size={16} />
              {u.name}
            </button>
          </li>
        ))}
      </ul>
      {visible.length === 0 && <EmptyState size="md" icon="search" title="No utilities match" />}
    </div>
  );
}

export default function DevUtilsView({ moduleId }: ToolViewProps) {
  const [saved, setSaved, loaded] = useModuleOptions<Saved>(moduleId, DEFAULTS, sanitize);
  const selected = useDevUtilsNav((s) => s.selected);
  const select = useDevUtilsNav((s) => s.select);

  // A file dropped on this tool (or sent to it) belongs to the Hash utility.
  const handoff = useUI((s) => s.handoff);
  useEffect(() => {
    if (handoff?.moduleId === moduleId) select("hash");
  }, [handoff, moduleId, select]);

  const currentId: UtilId = selected ?? (loaded ? saved.last : DEFAULTS.last);
  const current = UTILS.find((u) => u.id === currentId) ?? UTILS[0]!;

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
    <ClickInHost>
      <section className={styles.root} aria-label="Dev Utilities">
        <header className={styles.bar}>
          <ClickIn
            icon={current.icon}
            title="Utilities"
            summary={current.name}
            tip="Switch utility. Everything here runs on this computer; nothing is sent anywhere"
            className={styles.pickerRow}
            width={280}
          >
            <PickerList currentId={current.id} onChoose={choose} />
          </ClickIn>
        </header>
        <div className={styles.main}>
          <Suspense fallback={<Spinner />}>
            <Active key={current.id} />
          </Suspense>
        </div>
      </section>
    </ClickInHost>
  );
}
