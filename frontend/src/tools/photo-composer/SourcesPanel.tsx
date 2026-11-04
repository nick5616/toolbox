import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components";
import { PostsService, type PostSourceFile } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { SourceGrid } from "@/blocks/sources/SourceGrid";
import styles from "./SourcesPanel.module.css";

export interface SourcesPanelProps {
  postId: string;
  /** Double-click or Enter on a photo: add it as a layer at the centre. */
  onAdd: (paths: string[]) => void;
}

/** The post's photos, to add to the composition by double-click or by dragging onto the canvas. */
export function SourcesPanel({ postId, onAdd }: SourcesPanelProps) {
  const [sources, setSources] = useState<PostSourceFile[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let off = false;
    setLoading(true);
    PostsService.Sources(postId)
      .then((list) => {
        if (off) return;
        setError("");
        setSources((list ?? []).filter((s) => s.kind === "photo"));
      })
      .catch((e) => {
        if (off) return;
        const err = toAppError(e);
        setSources([]);
        setError(err.hint ? `${err.message} ${err.hint}` : err.message);
      })
      .finally(() => !off && setLoading(false));
    return () => {
      off = true;
    };
  }, [postId, tick]);

  return (
    <div className={styles.panel} aria-label="Post sources">
      <div className={styles.head}>
        <h2 className={styles.title} data-tip="The photos collected in this post">Post photos</h2>
        <Button size="sm" variant="ghost" icon="refresh-cw" data-tip="Reload the list of photos in this post" loading={loading} onClick={refresh}>
          Refresh
        </Button>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          Couldn't list the post's photos. {error}
        </p>
      ) : (
        <div className={styles.grid}>
          <SourceGrid
            sources={sources}
            selected={selected}
            onSelectionChange={(next) => setSelected(new Set(next))}
            onActivate={(path) => onAdd([path])}
            tileSize={88}
            emptyLabel="This post has no photos yet."
          />
        </div>
      )}
      <p className={styles.hint}>Double-click a photo to add it, or drag it onto the canvas.</p>
    </div>
  );
}
