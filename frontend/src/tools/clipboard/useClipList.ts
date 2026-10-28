import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardService, type ClipItem, type ClipPage } from "@/lib/api";
import { on } from "@/lib/events";
import { toAppError } from "@/lib/errors";
import { kindToClipKind, matchesFilters, removeClips, sortClips, upsertClip, type KindFilter } from "./clips";

export interface UseClipListOptions {
  search: string;
  kind: KindFilter;
  /** Page size. */
  limit: number;
  /** Debounce for `search` changes (ms). */
  debounceMs?: number;
}

export interface ClipList {
  items: ClipItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string;
  hasMore: boolean;
  /** Re-fetches the first page (keeps showing the current items meanwhile). */
  refresh: () => void;
  loadMore: () => void;
  /** Optimistic local edits (the server events confirm them). */
  patch: (fn: (items: ClipItem[]) => ClipItem[]) => void;
}

/**
 * Server-backed clip list: debounced search + kind filter, cursor paging and
 * live updates from clipboard:added / clipboard:removed.
 */
export function useClipList({ search, kind, limit, debounceMs = 250 }: UseClipListOptions): ClipList {
  const [items, setItems] = useState<ClipItem[]>([]);
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [debounced, setDebounced] = useState(search);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (search === debounced) return;
    if (search === "") {
      setDebounced(""); // clearing is instant (e.g. window:show reset)
      return;
    }
    const t = setTimeout(() => setDebounced(search), debounceMs);
    return () => clearTimeout(t);
  }, [search, debounced, debounceMs]);

  // The live filters, for event handlers.
  const filters = useRef({ search: debounced, kind });
  filters.current = { search: debounced, kind };

  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    ClipboardService.List({ search: debounced.trim(), kind: kindToClipKind(kind), limit, cursor: "" }).then(
      (page: ClipPage) => {
        if (my !== seq.current) return;
        setItems(sortClips(page.items ?? []));
        setCursor(page.nextCursor);
        setError("");
        setLoading(false);
        setLoadingMore(false);
      },
      (e: unknown) => {
        if (my !== seq.current) return;
        setError(toAppError(e).message);
        setLoading(false);
      },
    );
  }, [debounced, kind, limit, nonce]);

  useEffect(() => {
    const offAdded = on("clipboard:added", (item) => {
      const f = filters.current;
      setItems((cur) => (matchesFilters(item, f.search, f.kind) ? upsertClip(cur, item) : removeClips(cur, [item.id])));
    });
    const offRemoved = on("clipboard:removed", (ev) => {
      const ids = ev.ids ?? [];
      setItems((cur) => removeClips(cur, ids));
    });
    return () => {
      offAdded();
      offRemoved();
    };
  }, []);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const my = seq.current;
    setLoadingMore(true);
    ClipboardService.List({ search: debounced.trim(), kind: kindToClipKind(kind), limit, cursor }).then(
      (page) => {
        if (my !== seq.current) return;
        setItems((cur) => {
          const have = new Set(cur.map((i) => i.id));
          return [...cur, ...(page.items ?? []).filter((i) => !have.has(i.id))];
        });
        setCursor(page.nextCursor);
        setLoadingMore(false);
      },
      (e: unknown) => {
        if (my !== seq.current) return;
        setError(toAppError(e).message);
        setLoadingMore(false);
      },
    );
  }, [cursor, loadingMore, debounced, kind, limit]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const patch = useCallback((fn: (items: ClipItem[]) => ClipItem[]) => setItems((cur) => fn(cur)), []);

  return { items, loading, loadingMore, error, hasMore: cursor !== "", refresh, loadMore, patch };
}
