import { useEffect, useMemo, useState } from "react";
import { Button, ConfirmDialog, Section, Select, Stepper, Switch, toast } from "@/components";
import { LibraryService, SearchService, type LibraryFolder } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { DEFAULT_SETTINGS, useSearch, useSearchSync } from "@/state/search";
import { SearchGate } from "./library/SearchStatusLine";
import { statusLine } from "./library/searchHits";
import styles from "./SettingsSearch.module.css";

/** The library's folders as library-relative paths (the root excluded), depth first. */
export function folderRels(root: LibraryFolder | null): string[] {
  const out: string[] = [];
  const walk = (f: LibraryFolder) => {
    for (const c of f.children ?? []) {
      if (c.rel) out.push(c.rel.replaceAll("\\", "/"));
      walk(c);
    }
  };
  if (root) walk(root);
  return out;
}

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

/** Settings → Search (Phase 20, SPEC §1.1): status, what to read, skipped folders, rescan/rebuild/delete and where the models come from. */
export function SettingsSearch() {
  useSearchSync();
  const status = useSearch((s) => s.status);
  const loaded = useSearch((s) => s.statusLoaded);
  const stored = useSearch((s) => s.settings);
  const settings = stored ?? DEFAULT_SETTINGS;
  const [folders, setFolders] = useState<LibraryFolder | null>(null);
  const [pick, setPick] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void useSearch.getState().loadSettings().catch(() => undefined);
    void useSearch.getState().loadStatus();
    let alive = true;
    void (async () => {
      try {
        const f = await LibraryService.Folders();
        if (alive) setFolders(f);
      } catch {
        if (alive) setFolders(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = (patch: Partial<typeof settings>) => void useSearch.getState().saveSettings(patch).catch(fail);
  const skip = settings.skip ?? [];
  const choices = useMemo(() => folderRels(folders).filter((r) => !skip.some((s) => r === s || r.startsWith(`${s}/`))), [folders, skip]);
  const line = statusLine(status);

  const run = (what: () => Promise<void>, done: string) => () =>
    what()
      .then(() => {
        toast({ title: done });
        void useSearch.getState().loadStatus();
      })
      .catch(fail);

  return (
    <div id="settings-search">
      <Section label="Search" tip="Smart search: find files by what's in pictures and what files say">
        <div className={styles.stack}>
          {!status.installed && loaded ? <SearchGate /> : null}

          <div className={styles.inline}>
            <span className={styles.statusText} role="status" data-testid="settings-search-status">
              {line.text}
              {status.installed && status.indexBytes > 0 ? ` · ${formatBytes(status.indexBytes)} on disk` : ""}
            </span>
            {status.installed ? (
              <Button
                size="sm"
                variant="secondary"
                icon={settings.paused ? "play" : "pause"}
                data-tip={settings.paused ? "Start indexing again" : "Stop indexing until you resume"}
                onClick={() => save({ paused: !settings.paused })}
              >
                {settings.paused ? "Resume" : "Pause"}
              </Button>
            ) : null}
          </div>
          {status.lastError ? <p className={styles.note}>Last problem: {status.lastError}</p> : null}

          <Switch checked={settings.enabled} onChange={(enabled) => save({ enabled })} label="Index in the background" tip="Keep the search index up to date while Toolbox runs, and only when your jobs are done" />
          <Switch checked={settings.readText} onChange={(readText) => save({ readText })} label="Read text in pictures and PDFs" tip="Find words inside screenshots, scans, photos of documents and PDFs" />
          <Switch checked={settings.speech} onChange={(speech) => save({ speech })} label="Listen to speech in videos and audio" tip="Transcribe what is said so you can search for it. This is the slowest part" />
          <div className={styles.inline}>
            <span id="speech-max-label" data-tip="Longer files wait until you ask for them">
              Transcribe automatically up to
            </span>
            <Stepper aria-labelledby="speech-max-label" min={1} max={600} step={5} unit="min" disabled={!settings.speech} value={settings.speechMaxMin} onChange={(speechMaxMin) => save({ speechMaxMin })} />
            <span>per file</span>
          </div>

          <div className={styles.block}>
            <h4 className={styles.sub} data-tip="Folders inside your library that are never indexed">
              Skip these folders
            </h4>
            {skip.length === 0 ? <p className={styles.note}>Nothing is skipped.</p> : null}
            <ul className={styles.skipList} aria-label="Skipped folders">
              {skip.map((r) => (
                <li key={r} className={styles.skipRow}>
                  <span className={styles.skipName} data-tip={r}>
                    {r}
                  </span>
                  <Button size="sm" variant="ghost" icon="x" data-tip={`Index ${r} again`} onClick={() => save({ skip: skip.filter((x) => x !== r) })}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <div className={styles.inline}>
              <Select
                size="sm"
                aria-label="Folder to skip"
                value={pick}
                onChange={setPick}
                options={[{ value: "", label: choices.length === 0 ? "No folders to add" : "Choose a folder…" }, ...choices.map((r) => ({ value: r, label: r }))]}
              />
              <Button
                size="sm"
                variant="secondary"
                icon="plus"
                disabled={pick === ""}
                data-tip={pick === "" ? "Choose one of your library's folders first" : `Never index ${pick}`}
                onClick={() => {
                  save({ skip: [...skip, pick] });
                  setPick("");
                }}
              >
                Add
              </Button>
            </div>
          </div>

          <div className={styles.inline}>
            <Button size="sm" variant="secondary" icon="refresh-cw" data-tip="Look for new and changed files now" onClick={run(() => SearchService.Rescan(), "Looking for new files")}>
              Rescan now
            </Button>
            <Button size="sm" variant="secondary" icon="rotate-cw" data-tip="Forget what was read and read every file again. This can take a long time" onClick={run(() => SearchService.Rebuild(), "Rebuilding the index")}>
              Rebuild index
            </Button>
            <Button size="sm" variant="danger" icon="trash-2" data-tip="Delete the search index. Your files are not touched" onClick={() => setConfirmDelete(true)}>
              Delete index
            </Button>
          </div>

          <div className={styles.block}>
            <p className={styles.origin}>SigLIP 2 by Google — trained on WebLI (web images with alt text) — Apache-2.0</p>
            <p className={styles.origin}>RapidOCR (PP-OCR) — Apache-2.0</p>
            <p className={styles.origin}>Whisper small by OpenAI — MIT. All run on this computer.</p>
          </div>
        </div>
      </Section>
      <ConfirmDialog
        open={confirmDelete}
        tone="danger"
        title="Delete the search index?"
        body={
          <p>
            This frees {formatBytes(status.indexBytes)}. Your files aren&apos;t touched. Searching by what&apos;s in pictures and what files say stops working until the index is built again.
          </p>
        }
        confirmLabel="Delete index"
        onConfirm={() => {
          setConfirmDelete(false);
          run(() => SearchService.DeleteIndex(), "Search index deleted")();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
