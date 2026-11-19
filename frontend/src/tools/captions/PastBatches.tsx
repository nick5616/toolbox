import { useState } from "react";
import { ClickIn, ConfirmDialog, EmptyState, IconButton, Spinner, cx, useClickIn } from "@/components";
import type { CaptionBatchInfo } from "@/lib/api";
import { formatResultDate } from "@/tools/_kit";
import { useThumbState } from "@/lib/thumbs";
import styles from "./captions.module.css";

function Cover({ path }: { path: string }) {
  const t = useThumbState(path, 64, path !== "");
  return <span className={styles.cover}>{t.status === "ok" ? <img src={t.src} alt="" className={styles.thumbImg} /> : null}</span>;
}

export interface PastBatchesProps {
  /** null while loading. */
  batches: CaptionBatchInfo[] | null;
  currentDir: string;
  onOpen: (dir: string) => Promise<void> | void;
  onDelete: (dir: string) => Promise<void> | void;
}

const DRAWER = "captions-past";

function List({ batches, currentDir, onOpen, onDelete }: PastBatchesProps) {
  const [confirm, setConfirm] = useState<CaptionBatchInfo | null>(null);
  const clickIn = useClickIn();
  if (batches === null) return <Spinner />;
  return (
    <div className={styles.pastList}>
      {batches.length === 0 ? (
        <EmptyState icon="history" title="No batches yet" body="Batches you write are kept in your library under Captions, and appear here." />
      ) : (
        <ul className={styles.past} aria-label="Past batches">
          {batches.map((b) => (
            <li key={b.dir} className={cx(styles.pastRow, b.dir === currentDir && styles.pastCurrent)}>
              <button
                type="button"
                className={styles.pastOpen}
                data-tip={`${b.dir}\nOpen this batch to keep editing it`}
                onClick={async () => {
                  await onOpen(b.dir);
                  clickIn.close();
                }}
              >
                <Cover path={b.cover} />
                <span className={styles.pastName}>{b.name}</span>
                <span className={styles.pastMeta}>
                  {b.count} {b.count === 1 ? "file" : "files"}
                  {b.failed > 0 ? ` · ${b.failed} failed` : ""} · {formatResultDate(b.created)}
                </span>
              </button>
              <IconButton size="sm" icon="trash-2" label={`Delete ${b.name}`} data-tip="Move this batch's folder to the trash" onClick={() => setConfirm(b)} />
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title="Delete this batch?"
        body={confirm ? `“${confirm.name}” and the files in its folder (the text, With captions and Renamed copies) move to the trash. Your original photos are not touched.` : undefined}
        confirmLabel="Move to trash"
        tone="danger"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const b = confirm;
          setConfirm(null);
          if (b) void onDelete(b.dir);
        }}
      />
    </div>
  );
}

/** Earlier batches, newest first, in a click-in. */
export function PastBatches(props: PastBatchesProps) {
  const n = props.batches?.length ?? 0;
  return (
    <ClickIn id={DRAWER} icon="history" title="Past batches" summary={props.batches === null ? "" : n === 0 ? "None yet" : `${n} ${n === 1 ? "batch" : "batches"}`} tip="Open an earlier batch to keep editing it, or delete it" width={400}>
      <div className={styles.drawerBody}>
        <List {...props} />
      </div>
    </ClickIn>
  );
}
