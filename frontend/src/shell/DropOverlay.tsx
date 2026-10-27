import { isReady } from "@/state/modules";
import { useUI } from "@/state/ui";
import { Badge, Button, Icon } from "@/components";
import styles from "./DropOverlay.module.css";

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Full-window hint (CSS-driven) plus the chooser panel shown after a drop. */
export function DropOverlay() {
  const drop = useUI((s) => s.drop);
  const setDrop = useUI((s) => s.setDrop);
  const handOff = useUI((s) => s.handOff);

  return (
    <>
      <div className={styles.hint} aria-hidden="true">
        <div className={styles.hintBox}>Drop files to see which tools can use them</div>
      </div>
      {drop && (
        <div className={styles.backdrop} onMouseDown={() => setDrop(null)}>
          <div
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-label="Choose a tool for dropped files"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <DropContent drop={drop} onPick={(moduleId, inputs) => handOff({ moduleId, inputs })} onClose={() => setDrop(null)} />
          </div>
        </div>
      )}
    </>
  );
}

function DropContent({
  drop,
  onPick,
  onClose,
}: {
  drop: NonNullable<ReturnType<typeof useUI.getState>["drop"]>;
  onPick: (moduleId: string, inputs: string[]) => void;
  onClose: () => void;
}) {
  const paths = drop.paths ?? [];
  const matches = drop.result.matches ?? [];
  const unmatched = drop.result.unmatched ?? [];
  const first = paths.slice(0, 3).map(baseName);
  return (
    <>
      <div className={styles.head}>
        <div className={styles.count}>
          {paths.length} {paths.length === 1 ? "file" : "files"}
        </div>
        <div className={styles.names}>
          {first.join(", ")}
          {paths.length > 3 ? `, +${paths.length - 3} more` : ""}
        </div>
      </div>
      {matches.length === 0 ? (
        <div className={styles.none}>No tool accepts these files yet.</div>
      ) : (
        <ul className={styles.matches}>
          {matches.map((m) => {
            const ready = isReady(m.module);
            const mp = m.paths ?? [];
            return (
              <li key={m.module.id} className={styles.match}>
                <Icon name={m.module.icon} size={16} />
                <div className={styles.matchText}>
                  <div className={styles.matchName}>{m.module.name}</div>
                  <div className={styles.matchFiles}>{mp.map(baseName).join(", ")}</div>
                </div>
                {ready ? (
                  <Button size="sm" variant="primary" onClick={() => onPick(m.module.id, mp)}>
                    Open
                  </Button>
                ) : (
                  <>
                    <Badge>SOON</Badge>
                    <Button size="sm" disabled>
                      Open
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {unmatched.length > 0 && <div className={styles.unsupported}>Unsupported: {unmatched.map(baseName).join(", ")}</div>}
      <div className={styles.foot}>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}
