import { useEffect, useState } from "react";
import { Button, Modal, cx, toast } from "@/components";
import { PacksService, PackState, SearchService, type SearchFailure } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useJobs } from "@/state/jobs";
import { usePacks } from "@/state/packs";
import { useSearch } from "@/state/search";
import { packSizes, formatSize } from "@/views/setup/packSizes";
import { baseOf } from "./items";
import { openSettingsSearch } from "./searchNav";
import { statusLine } from "./searchHits";
import styles from "./Search.module.css";

export const SEARCH_PACK_ID = "search";

/** The Smart search pack: its state and the install action (the same call every pack button makes). */
export function useSearchPack() {
  const pack = usePacks((s) => s.byId[SEARCH_PACK_ID]);
  const list = usePacks((s) => s.list);
  const [busy, setBusy] = useState(false);
  const size = pack ? (packSizes(list, [SEARCH_PACK_ID]).byPack[SEARCH_PACK_ID]?.disk ?? 0) : 0;
  const installing = busy || !!pack?.jobId;
  const canInstall = !!pack && pack.state !== PackState.PackInstalled && pack.state !== PackState.PackUnsupported;
  const install = async () => {
    setBusy(true);
    try {
      const res = await PacksService.Install([SEARCH_PACK_ID], "");
      for (const j of res.jobs ?? []) useJobs.getState().upsert(j);
      if (res.restart) await PacksService.Relaunch();
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return { pack, size, installing, canInstall, install };
}

/** "Search by what's in your pictures and what your files say" with the Smart search pack's install button. */
export function SearchGate({ className }: { className?: string }) {
  const { pack, size, installing, canInstall, install } = useSearchPack();
  return (
    <div className={cx(styles.gate, className)} role="status" data-testid="search-gate">
      <span className={styles.gateText}>Search by what's in your pictures and what your files say</span>
      {canInstall ? (
        <Button size="sm" variant="primary" icon="download" loading={installing} data-tip={`Install the ${pack?.name ?? "Smart search"} pack. Indexing starts by itself afterwards`} onClick={() => void install()}>
          {size > 0 ? `Install Smart search (≈ ${formatSize(size)})` : "Install Smart search"}
        </Button>
      ) : pack?.state === PackState.PackUnsupported ? (
        <span data-tip={pack.unsupportedReason}>Not available on this computer</span>
      ) : null}
    </div>
  );
}

function FailuresModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<SearchFailure[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    SearchService.Failures(100)
      .then((r) => alive && setRows(r ?? []))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);
  const retry = async (paths: string[]) => {
    try {
      await SearchService.Retry(paths);
      setRows((cur) => (cur ?? []).filter((r) => !paths.includes(r.path)));
      toast({ title: paths.length === 1 ? "Will try that file again" : `Will try ${paths.length} files again` });
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
  return (
    <Modal title="Files that couldn't be indexed" onClose={onClose}>
      {error ? <p>Couldn't load the list.</p> : null}
      {rows && rows.length === 0 ? <p>Nothing left to show.</p> : null}
      {rows && rows.length > 0 ? (
        <>
          <ul className={styles.failures} aria-label="Failed files">
            {rows.map((r) => (
              <li key={r.path} className={styles.failure}>
                <span className={styles.failName} data-tip={r.path}>
                  {baseOf(r.path)}
                </span>
                <Button size="sm" variant="ghost" icon="rotate-cw" data-tip="Try this file again" onClick={() => void retry([r.path])}>
                  Retry
                </Button>
                <span className={styles.failWhy}>{r.reason}</span>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="secondary" icon="rotate-cw" data-tip="Try every file in this list again" onClick={() => void retry(rows.map((r) => r.path))}>
            Retry all
          </Button>
        </>
      ) : null}
    </Modal>
  );
}

/** The one-line index status (SPEC §1.1). A click opens Settings → Search. */
export function SearchStatusLine({ block = false }: { block?: boolean }) {
  const status = useSearch((s) => s.status);
  const loaded = useSearch((s) => s.statusLoaded);
  const [showFailures, setShowFailures] = useState(false);
  if (!loaded) return null;
  const line = statusLine(status);
  const resume = () =>
    useSearch
      .getState()
      .saveSettings({ paused: false })
      .catch((e: unknown) => toast({ title: toAppError(e).message, tone: "danger" }));
  return (
    <div className={cx(styles.status, block && styles.statusBlock, styles[`tone_${line.tone}`])} data-testid="search-status">
      <button type="button" className={styles.statusBtn} data-tip="Open the search settings" onClick={openSettingsSearch}>
        <span className={styles.statusDot} aria-hidden="true" />
        <span>{line.text}</span>
      </button>
      {line.action === "resume" ? (
        <button type="button" className={styles.hintLink} data-tip="Start indexing again" onClick={() => void resume()}>
          Resume
        </button>
      ) : null}
      {status.installed && status.failed > 0 ? (
        <>
          {line.action === "failures" ? null : <span>· {status.failed.toLocaleString("en-US")} couldn't be indexed</span>}
          <button type="button" className={styles.hintLink} data-tip="See which files couldn't be indexed and why" onClick={() => setShowFailures(true)}>
            Show
          </button>
        </>
      ) : null}
      {showFailures ? <FailuresModal onClose={() => setShowFailures(false)} /> : null}
    </div>
  );
}
