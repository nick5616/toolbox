// The post's source pool inside the Video Editor (SPEC.md §B13.5): activate
// (double-click / Enter) appends a clip; dragging onto the clips lane inserts.
import { useCallback, useEffect, useState } from "react";
import { Banner, Button } from "@/components";
import { PostsService, type PostSourceFile } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { SourceGrid } from "@/tools/post-builder/SourceGrid";
import styles from "./VideoEditorView.module.css";

export function SourcesTab({ postId, onAdd }: { postId: string; onAdd: (paths: string[]) => void }) {
  const [sources, setSources] = useState<PostSourceFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await PostsService.Sources(postId)) ?? [];
      setSources(list);
      setError("");
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={styles.sourcesTab}>
      <div className={styles.sourcesBar}>
        <Button size="sm" icon="refresh-cw" data-tip="Reload the list of photos and videos in this post" loading={loading} onClick={() => void load()}>
          Refresh
        </Button>
        <Button size="sm" data-tip={selected.size === 0 ? "Select one or more sources first" : "Add the selected sources to the end of the timeline"} disabled={selected.size === 0} onClick={() => onAdd(sources.filter((s) => selected.has(s.path)).map((s) => s.path))}>
          Add selected
        </Button>
      </div>
      <p className={styles.sourcesHint}>Double-click to add at the end, or drag onto the clips lane.</p>
      {error && <Banner tone="warn">{error}</Banner>}
      <SourceGrid
        sources={sources}
        selected={selected}
        onSelectionChange={setSelected}
        onActivate={(path) => onAdd([path])}
        emptyLabel={loading ? "Loading…" : "No sources"}
      />
    </div>
  );
}
