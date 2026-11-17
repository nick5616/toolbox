import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ClickIn,
  ConfirmDialog,
  DropZone,
  EmptyState,
  Field,
  Icon,
  IconButton,
  MenuButton,
  Select,
  TextField,
  toast,
} from "@/components";
import { FilesService, VaultService, type VaultEntry, type VaultState } from "@/lib/api";
import { useToolHandoff } from "@/lib/embed";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { announceWhenDone, isActive, useOrderedJobs } from "@/state/jobs";
import { useClickIn } from "@/components/ClickIn";
import { ToolHeader } from "@/components/ToolHeader";
import { submitJobs } from "@/tools/_kit/enqueue";
import { formatLockIn, useNow } from "./useVaultState";
import styles from "./vault.module.css";

const ALL = "\u0000all";
const ROOT = "";
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
const ICON_BY_EXT: Record<string, string> = {
  mp3: "music",
  wav: "music",
  flac: "music",
  m4a: "music",
  ogg: "music",
  mp4: "film",
  mov: "film",
  mkv: "film",
  webm: "film",
  pdf: "file-text",
  txt: "file-text",
  md: "file-text",
  doc: "file-text",
  docx: "file-text",
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}
export const isImageName = (name: string) => IMAGE_EXT.has(extOf(name));
const iconFor = (name: string) => (isImageName(name) ? "image" : (ICON_BY_EXT[extOf(name)] ?? "file"));
const fail = (e: unknown) => {
  const err = toAppError(e);
  toast({ title: err.message, description: err.hint, tone: "danger" });
};
const formatDate = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

type Dialog =
  | { kind: "delete"; ids: string[] }
  | { kind: "rename"; entry: VaultEntry }
  | { kind: "move"; ids: string[] }
  | null;

function Preview({ entry, url, onClose }: { entry: VaultEntry; url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={styles.previewPanel} role="dialog" aria-modal="true" aria-label={`Preview of ${entry.name}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.previewHead}>
          <span className={styles.previewName}>{entry.name}</span>
          <IconButton size="sm" icon="x" label="Close preview" data-tip="Close the preview; the decrypted copy is removed" kbd="Esc" onClick={onClose} />
        </div>
        <img className={styles.previewImg} src={url} alt={entry.name} />
      </div>
    </div>
  );
}

export function UnlockedPanel({ state }: { state: VaultState }) {
  const [folder, setFolder] = useState(ALL);
  const [folders, setFolders] = useState<string[]>([]);
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [text, setText] = useState("");
  const [moveTarget, setMoveTarget] = useState(ROOT);
  const [newFolder, setNewFolder] = useState("");
  const [folderDialog, setFolderDialog] = useState(false);
  const [preview, setPreview] = useState<{ entry: VaultEntry; url: string } | null>(null);
  const seq = useRef(0);

  const now = useNow(state.lockAt > 0);
  const lockIn = formatLockIn(state.lockAt, now);

  const jobs = useOrderedJobs("vault");
  const activeJobs = jobs.filter(isActive).length;

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    try {
      // List("") returns every entry (all folders); the root view filters it. Independent calls: together.
      const [fsRaw, listRaw] = await Promise.all([
        VaultService.Folders(),
        VaultService.List(folder === ALL ? ROOT : folder, search),
      ]);
      const fs = fsRaw ?? [];
      const list = listRaw ?? [];
      if (my !== seq.current) return;
      setFolders(fs);
      setEntries(folder === ROOT ? list.filter((e) => e.folder === ROOT) : list);
      setLoaded(true);
    } catch (e) {
      if (my === seq.current) fail(e);
    }
  }, [folder, search]);

  useEffect(() => {
    void refresh();
  }, [refresh, state.entries, activeJobs]);

  // Drop the selection of rows that no longer exist.
  useEffect(() => {
    setSelected((cur) => {
      const ids = new Set(entries.map((e) => e.id));
      const next = new Set([...cur].filter((id) => ids.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [entries]);

  const sorted = useMemo(() => [...entries].sort((a, b) => a.name.localeCompare(b.name)), [entries]);
  const allFolders = useMemo(() => [...new Set([...folders, ...extraFolders])].sort((a, b) => a.localeCompare(b)), [folders, extraFolders]);

  const addTarget = folder === ALL ? ROOT : folder;
  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      await submitJobs(() => VaultService.Enqueue(paths, addTarget), paths, ["file", "files"]);
    },
    [addTarget],
  );

  const pick = async () => {
    try {
      await addPaths((await FilesService.Pick("vault")) ?? []);
    } catch (e) {
      fail(e);
    }
  };

  // Files dropped onto the Vault while it is unlocked.
  useToolHandoff("vault", (h) => void addPaths(h.inputs));

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast({ title: done, tone: "success" });
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  const exportIds = (ids: string[]) =>
    void act(async () => {
      const jobsOut = await VaultService.Export(ids);
      // Each finished export toasts with Reveal, even though the Vault is on screen.
      for (const j of jobsOut ?? []) announceWhenDone(j.id);
      toast({ title: `${jobsOut?.length ?? ids.length} ${ids.length === 1 ? "file" : "files"} exporting`, tone: "success" });
    });

  const openPreview = async (entry: VaultEntry) => {
    try {
      setPreview({ entry, url: await VaultService.Preview(entry.id) });
    } catch (e) {
      fail(e);
    }
  };

  const selectedIds = [...selected];
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const allSelected = sorted.length > 0 && selected.size === sorted.length;

  const confirmDialog = () => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    if (d.kind === "delete") void act(() => VaultService.Delete(d.ids));
    else if (d.kind === "rename") {
      const name = text.trim();
      if (name && name !== d.entry.name) void act(() => VaultService.Rename(d.entry.id, name));
    } else {
      const target = newFolder.trim() || moveTarget;
      void act(async () => {
        await VaultService.Move(d.ids, target);
        setSelected(new Set());
      });
    }
  };

  const openMove = (ids: string[]) => {
    setMoveTarget(ROOT);
    setNewFolder("");
    setDialog({ kind: "move", ids });
  };

  const clickIn = useClickIn();
  const folderLabel = folder === ALL ? "All files" : folder === ROOT ? "Unfiled" : folder;
  const deleteCount = dialog?.kind === "delete" ? dialog.ids.length : 0;

  return (
    <>
      <ToolHeader className={styles.header} aria-label="Vault">
        <div className={styles.status} data-tip="The vault is open. It locks by itself after the time set in Settings">
          <Icon name="lock" size={16} className={styles.statusIcon} />
          <span aria-live="off">{lockIn ? `Unlocked · locks in ${lockIn}` : "Unlocked"}</span>
        </div>
        <ClickIn icon="folder" title="Folders" summary={folderLabel} tip="Choose which vault folder to show, or make a new one" className={styles.foldersRow} width={300}>
          <nav className={styles.folders} aria-label="Folders">
            {[
              { id: ALL, label: "All files", icon: "archive" },
              { id: ROOT, label: "Unfiled", icon: "folder" },
              ...allFolders.map((f) => ({ id: f, label: f, icon: "folder" })),
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                className={`${styles.folder} ${folder === f.id ? styles.folderActive : ""}`}
                aria-current={folder === f.id ? "page" : undefined}
                data-tip={f.id === ALL ? "Show every file in the vault" : f.id === ROOT ? "Files not in any folder" : `Show the files in ${f.label}`}
                onClick={() => {
                  setFolder(f.id);
                  setSelected(new Set());
                  clickIn.close();
                }}
              >
                <Icon name={f.icon} size={14} />
                <span className={styles.folderName}>{f.label}</span>
              </button>
            ))}
            <Button size="sm" variant="ghost" icon="folder-plus" data-tip="Make a folder to organise vault files; it appears once you move a file into it" onClick={() => { setText(""); clickIn.close(); setFolderDialog(true); }}>
              New folder
            </Button>
          </nav>
        </ClickIn>
        <Button variant="secondary" icon="lock" data-tip="Lock now: forget the key from memory and delete any opened temporary copies" onClick={() => void VaultService.Lock().catch(fail)}>
          Lock
        </Button>
        <Button variant="primary" icon="plus" data-tip="Choose files to copy into the vault, encrypted; your originals stay where they are" onClick={() => void pick()}>
          Add files
        </Button>
      </ToolHeader>

      <div className={styles.body}>
        <div className={styles.main}>
          <div className={styles.toolbar}>
            <TextField
              size="sm"
              icon="search"
              aria-label="Search files"
              data-tip="Search file names in the current folder"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className={styles.toolbarSpacer} />
            {selected.size > 0 && (
              <>
                <span className={styles.selection} data-tip="Files ticked in the list">{selected.size} selected</span>
                <Button size="sm" variant="secondary" icon="arrow-down-to-line" collapsible data-tip="Decrypt copies of the selected files into a folder you choose" onClick={() => exportIds(selectedIds)}>
                  Export selected
                </Button>
                <Button size="sm" variant="secondary" icon="folder-input" collapsible data-tip="Move the selected files to another vault folder" onClick={() => openMove(selectedIds)}>
                  Move selected…
                </Button>
                <Button size="sm" variant="danger" icon="trash-2" collapsible data-tip="Permanently delete the selected files from the vault" onClick={() => setDialog({ kind: "delete", ids: selectedIds })}>
                  Delete selected
                </Button>
              </>
            )}
          </div>

          {loaded && sorted.length === 0 ? (
            search ? (
              <EmptyState icon="search" title="No matching files." />
            ) : (
              <DropZone id="tool-drop:vault" label="Drop files here to encrypt them" hint="Adding copies the files; your originals stay where they are.">
                <Button size="sm" variant="secondary" icon="plus" data-tip="Choose files to encrypt into the vault" onClick={() => void pick()}>
                  Add files…
                </Button>
              </DropZone>
            )
          ) : (
            <table className={styles.table} aria-label="Vault files">
              <thead>
                <tr>
                  <th className={styles.colCheck}>
                    <input
                      type="checkbox"
                      aria-label="Select all files"
                      data-tip="Tick or untick every file in this list"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(sorted.map((e) => e.id)))}
                    />
                  </th>
                  <th className={styles.colIcon}>
                    <span className={styles.srOnly}>Type</span>
                  </th>
                  <th data-tip="The decrypted file name">Name</th>
                  <th data-tip="The file's original size">Size</th>
                  <th data-tip="When the file was put in the vault">Added</th>
                  <th>
                    <span className={styles.srOnly}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) => (
                  <tr key={e.id}>
                    <td className={styles.colCheck}>
                      <input type="checkbox" data-tip="Tick to use this file in bulk actions" aria-label={`Select ${e.name}`} checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                    </td>
                    <td className={styles.colIcon} data-tip="File type">
                      <Icon name={iconFor(e.name)} size={14} />
                    </td>
                    <td className={styles.nameCell} data-tip={e.name}>
                      {e.name}
                    </td>
                    <td className={styles.colSize}>{formatBytes(e.size)}</td>
                    <td className={styles.colDate}>{formatDate(e.addedAt)}</td>
                    <td className={styles.colActions}>
                      <IconButton size="sm" icon="external-link" label={`Open ${e.name}`} data-tip="Decrypt a temporary copy and open it with your default app; it is wiped when you lock" onClick={() => void VaultService.Open(e.id).catch(fail)} />
                      {isImageName(e.name) && (
                        <IconButton size="sm" icon="eye" label={`Preview ${e.name}`} data-tip="Look at this image here without opening another app" onClick={() => void openPreview(e)} />
                      )}
                      <IconButton size="sm" icon="arrow-down-to-line" label={`Export ${e.name}`} data-tip="Save a decrypted copy to a folder you choose" onClick={() => exportIds([e.id])} />
                      <MenuButton
                        size="sm"
                        variant="ghost"
                        icon="chevron-down"
                        label={`More actions for ${e.name}`}
                        tip="Rename or move this file"
                        items={() => [
                          {
                            id: "rename",
                            label: "Rename…",
                            tip: "Change the file name inside the vault",
                            onSelect: () => {
                              setText(e.name);
                              setDialog({ kind: "rename", entry: e });
                            },
                          },
                          { id: "move", label: "Move to…", tip: "Put this file in another vault folder", onSelect: () => openMove([e.id]) },
                        ]}
                      />
                      <IconButton
                        size="sm"
                        variant="danger"
                        icon="trash-2"
                        label={`Delete ${e.name}`}
                        data-tip="Permanently delete this file from the vault"
                        onClick={() => setDialog({ kind: "delete", ids: [e.id] })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {sorted.length > 0 && (
            <DropZone id="tool-drop:vault" className={styles.dropLine} label="Drop files here to encrypt them">
              <Button size="sm" variant="secondary" icon="plus" data-tip="Choose files to encrypt into the vault" onClick={() => void pick()}>
                Add files…
              </Button>
            </DropZone>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={dialog?.kind === "delete"}
        tone="danger"
        title="Permanently delete from the vault?"
        body={`${deleteCount} ${deleteCount === 1 ? "file" : "files"} will be deleted. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={confirmDialog}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "rename"}
        title="Rename file"
        body={
          <Field label="Name">
            {(c) => <TextField {...c} data-tip="The new file name, including its extension" autoFocus value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        }
        confirmLabel="Rename"
        onConfirm={confirmDialog}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "move"}
        title="Move to…"
        body={
          <div className={styles.dialogBody}>
            <Field label="Folder">
              {(c) => (
                <Select
                  {...c}
                  data-tip="The existing folder to move into"
                  value={moveTarget}
                  onChange={setMoveTarget}
                  options={[{ value: ROOT, label: "Unfiled" }, ...allFolders.map((f) => ({ value: f, label: f }))]}
                />
              )}
            </Field>
            <Field label="Or a new folder">
              {(c) => <TextField {...c} data-tip="Type a name to create a new folder; this wins over the list above" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />}
            </Field>
          </div>
        }
        confirmLabel="Move"
        onConfirm={confirmDialog}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={folderDialog}
        title="New folder"
        body={
          <Field label="Folder name">
            {(c) => <TextField {...c} data-tip="Name for the new folder" autoFocus value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        }
        confirmLabel="Create"
        onConfirm={() => {
          const name = text.trim();
          setFolderDialog(false);
          if (!name) return;
          setExtraFolders((cur) => (cur.includes(name) ? cur : [...cur, name]));
          setFolder(name);
        }}
        onCancel={() => setFolderDialog(false)}
      />
      {preview && <Preview entry={preview.entry} url={preview.url} onClose={() => setPreview(null)} />}
    </>
  );
}
