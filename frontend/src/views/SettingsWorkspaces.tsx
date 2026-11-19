import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Banner, Button, ConfirmDialog, Field, Modal, PathText, Section, Select, Switch, TextField, toast } from "@/components";
import { FilesService, LibraryService, SettingsService, WorkspaceKind, WorkspacesService, type WorkspaceInfo, type WorkspaceTidyPlan } from "@/lib/api";
import { useDisplayPath } from "@/lib/displayPath";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { announceWhenDone, useJobs } from "@/state/jobs";
import { useSettings } from "@/state/settings";
import { WORKSPACE_SETTINGS_ANCHOR, isPersonal, switchTo, useWorkspace, workspaceDot } from "@/state/workspace";
import styles from "./SettingsWorkspaces.module.css";

const MODULE_STATE_ID = "workspaces";
export const NAME_MAX = 40;
const DEFAULT_PARENT_NAME = "Toolbox Workspaces";

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

const KIND_LABEL: Record<string, string> = {
  [WorkspaceKind.KindPersonal]: "Personal",
  [WorkspaceKind.KindStandard]: "Standard",
  [WorkspaceKind.KindDemo]: "Demo",
  [WorkspaceKind.KindSandbox]: "Sandbox",
};

export const PERSONAL_RENAME_REASON = "Personal is your own workspace and keeps its name";
export const PERSONAL_REMOVE_REASON = "Personal can't be removed from the list";
export const MISSING_SWITCH_REASON = "This workspace's folder isn't there. Plug the drive back in or remove it from the list";

/** Joins with the separator the parent already uses ("\" on Windows). */
export function joinPath(parent: string, name: string): string {
  const p = parent.replace(/[\\/]+$/, "");
  if (!p) return name;
  return `${p}${p.includes("\\") ? "\\" : "/"}${name}`;
}

/** A folder name from a workspace name: no path-hostile characters, trimmed. */
export function folderNameFor(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().replace(/[. ]+$/, "");
}

/** The default folder: `<parent>/<Name>` ("" until there is a name). */
export function defaultFolder(parent: string, name: string): string {
  const leaf = folderNameFor(name);
  return leaf ? joinPath(parent, leaf) : "";
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : "";
}

export interface NewWorkspaceFields {
  name: string;
  folder: string;
  baseline: string;
}

/** Field errors for the New workspace dialog (empty object = valid). */
export function validateNewWorkspace(f: NewWorkspaceFields): Partial<Record<"name" | "folder", string>> {
  const out: Partial<Record<"name" | "folder", string>> = {};
  const name = f.name.trim();
  if (name.length < 1) out.name = "Give the workspace a name";
  else if (name.length > NAME_MAX) out.name = `Use at most ${NAME_MAX} characters`;
  if (!f.folder.trim()) out.folder = "Choose a folder";
  else if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(f.folder.trim())) out.folder = "Use a full path, starting from a drive or /";
  return out;
}

function sizeText(plan: WorkspaceTidyPlan): string {
  return `${plan.files} file${plan.files === 1 ? "" : "s"}, ${formatBytes(plan.bytes)}`;
}

/** Settings → Workspaces (Phase 21, SPEC A1). */
export function SettingsWorkspaces() {
  const list = useWorkspace((s) => s.list);
  const current = useWorkspace((s) => s.current);
  const newRequested = useWorkspace((s) => s.newRequested);
  const libraryDir = useSettings((s) => s.settings.libraryDir);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<WorkspaceInfo | null>(null);
  const [removing, setRemoving] = useState<WorkspaceInfo | null>(null);
  const [tidyPlan, setTidyPlan] = useState<WorkspaceTidyPlan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!newRequested) return;
    useWorkspace.getState().setNewRequested(false);
    setCreating(true);
  }, [newRequested]);

  const reload = () => void useWorkspace.getState().load().catch(() => undefined);

  const reveal = (w: WorkspaceInfo) => {
    const path = isPersonal(w) ? libraryDir : w.root;
    if (path) void LibraryService.RevealPath(path).catch(fail);
  };

  const addExisting = async () => {
    try {
      const dir = await FilesService.PickFolder("Choose a workspace folder");
      if (!dir) return;
      const info = await WorkspacesService.AddExisting(dir);
      toast({ tone: "success", title: `Added ${info.name}` });
      reload();
    } catch (e) {
      fail(e);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      const job = await WorkspacesService.Restore();
      useJobs.getState().upsert(job);
      announceWhenDone(job.id);
      toast({ tone: "neutral", title: "Restoring the starting files…" });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const previewTidy = async () => {
    setBusy(true);
    try {
      setTidyPlan(await WorkspacesService.TidyPreview());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const tidy = async () => {
    setTidyPlan(null);
    try {
      const job = await WorkspacesService.Tidy();
      useJobs.getState().upsert(job);
      announceWhenDone(job.id);
      toast({ tone: "neutral", title: "Tidying up…" });
    } catch (e) {
      fail(e);
    }
  };

  const setPresent = async (on: boolean) => {
    try {
      await WorkspacesService.SetPresent(on);
      reload();
    } catch (e) {
      fail(e);
    }
  };

  const isDemo = current?.kind === WorkspaceKind.KindDemo;
  const personal = isPersonal(current);
  const restoreReason = !current ? "Loading" : personal ? "Personal has no starting folder to restore" : !current.baseline ? "This workspace was made without a starting folder" : "";
  const tidyReason = !current ? "Loading" : !isDemo ? "Tidy up is for Demo workspaces; it would move your files to the trash" : "";

  return (
    <div id={WORKSPACE_SETTINGS_ANCHOR}>
      <Section
        label="Workspaces"
        tip="Separate libraries, histories and settings, for example a clean one for demos"
        action={
          <span className={styles.actions}>
            <Button size="sm" variant="secondary" icon="folder-plus" data-tip="Make a new workspace with its own library and settings" onClick={() => setCreating(true)}>
              New…
            </Button>
            <Button size="sm" variant="ghost" data-tip="Add a folder that already holds a workspace (it has a .toolbox folder inside)" onClick={() => void addExisting()}>
              Add existing folder…
            </Button>
          </span>
        }
      >
        <ul className={styles.list} aria-label="Workspaces">
          {list.map((w) => {
            const dot = workspaceDot(w);
            const folder = isPersonal(w) ? libraryDir : w.root;
            return (
              <li key={w.id} className={styles.row} data-testid={`workspace-row-${w.id}`}>
                <div className={styles.head}>
                  <span className={styles.name}>{w.name}</span>
                  {dot && <span className={`${styles.dot} ${styles[dot]}`} aria-hidden="true" />}
                  <Badge tone={w.kind === WorkspaceKind.KindDemo ? "accent" : "neutral"}>{KIND_LABEL[w.kind] ?? w.kind}</Badge>
                  {w.current && <Badge tone="ok" tip="You are in this workspace">Current</Badge>}
                  {w.missing && <Badge tone="warn" tip={MISSING_SWITCH_REASON}>Missing</Badge>}
                </div>
                {folder && <PathText path={folder} />}
                <div className={styles.buttons}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={w.current || w.missing}
                    data-tip={w.current ? "You are already in this workspace" : w.missing ? MISSING_SWITCH_REASON : `Quit and reopen Toolbox in ${w.name}`}
                    onClick={() => void switchTo(w.id)}
                  >
                    Switch
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isPersonal(w)}
                    data-tip={isPersonal(w) ? PERSONAL_RENAME_REASON : "Change the workspace's name"}
                    onClick={() => setRenaming(w)}
                  >
                    Rename
                  </Button>
                  <Button size="sm" variant="ghost" disabled={w.missing || !folder} data-tip={w.missing ? MISSING_SWITCH_REASON : "Show the folder in the file manager"} onClick={() => reveal(w)}>
                    Reveal
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isPersonal(w) || w.current}
                    data-tip={isPersonal(w) ? PERSONAL_REMOVE_REASON : w.current ? "Switch to another workspace first" : "Take it off this list. Its files stay where they are"}
                    onClick={() => setRemoving(w)}
                  >
                    Remove from list
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {/* Library size per workspace is left out: no cheap API for it (docs/DECISIONS.md). */}

        {current && (
          <div className={styles.extras} aria-label={`${current.name} (current workspace)`}>
            <h4 className={styles.sub}>This workspace</h4>
            <div className={styles.buttons}>
              <Button size="sm" variant="secondary" disabled={!!restoreReason || busy} data-tip={restoreReason || "Copy back any starting files that were deleted or changed. Nothing else is touched"} onClick={() => void restore()}>
                Restore baseline
              </Button>
              <Button size="sm" variant="secondary" disabled={!!tidyReason || busy} data-tip={tidyReason || "See what a demo left behind and move it to the trash"} onClick={() => void previewTidy()}>
                Tidy up after a demo…
              </Button>
            </div>
            <Switch
              checked={current.present}
              onChange={(on) => void setPresent(on)}
              label="Hide personal details"
              tip="Show folders as Name/… or ~/… and keep your user name off screen"
            />
          </div>
        )}
      </Section>

      {creating && <NewWorkspaceDialog onClose={() => setCreating(false)} onDone={reload} />}
      {renaming && <RenameDialog info={renaming} onClose={() => setRenaming(null)} onDone={reload} />}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? ""} from the list?`}
        body="Only the list entry goes. The workspace's folder and every file in it stay where they are, and you can add it back later."
        confirmLabel="Remove from list"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const w = removing;
          setRemoving(null);
          if (w)
            void WorkspacesService.Remove(w.id)
              .then(reload)
              .catch(fail);
        }}
      />
      {tidyPlan && <TidyDialog plan={tidyPlan} onClose={() => setTidyPlan(null)} onConfirm={() => void tidy()} />}
    </div>
  );
}

function TidyDialog({ plan, onClose, onConfirm }: { plan: WorkspaceTidyPlan; onClose: () => void; onConfirm: () => void }) {
  const blocked = plan.jobs > 0;
  const sample = plan.sample ?? [];
  return (
    <Modal title="Tidy up after a demo" confirmLabel={plan.files > 0 ? "Move to trash" : undefined} confirmDisabled={blocked} onConfirm={onConfirm} onClose={onClose} wide>
      {blocked && <Banner tone="warn">Wait for {plan.jobs} job{plan.jobs === 1 ? "" : "s"} to finish</Banner>}
      {plan.files === 0 ? (
        <p className={styles.note}>Nothing to tidy: every file in the library is a starting file or in a kept folder.</p>
      ) : (
        <>
          <p className={styles.note}>
            {sizeText(plan)} the demo made will move to the trash. Starting files and the kept folders stay, and so do projects, pipelines and settings. Finished job history is cleared.
          </p>
          <ul className={styles.sample} aria-label="Files that will move">
            {sample.map((p) => (
              <li key={p}>
                <PathText path={p} />
              </li>
            ))}
            {plan.files > sample.length && <li className={styles.more}>and {plan.files - sample.length} more</li>}
          </ul>
        </>
      )}
    </Modal>
  );
}

function RenameDialog({ info, onClose, onDone }: { info: WorkspaceInfo; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(info.name);
  const error = name.trim().length < 1 ? "Give the workspace a name" : name.trim().length > NAME_MAX ? `Use at most ${NAME_MAX} characters` : "";
  const save = () => {
    if (error) return;
    void WorkspacesService.Rename(info.id, name.trim())
      .then(() => {
        onDone();
        onClose();
      })
      .catch(fail);
  };
  return (
    <Modal title={`Rename ${info.name}`} confirmLabel="Rename" confirmDisabled={!!error} onConfirm={save} onClose={onClose}>
      <Field label="Name" error={error || undefined}>
        {(c) => <TextField {...c} value={name} maxLength={NAME_MAX + 10} onChange={(e) => setName(e.target.value)} data-tip="The name shown in the sidebar and the window title" />}
      </Field>
    </Modal>
  );
}

interface Remembered {
  parent?: string;
}

function NewWorkspaceDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const home = useWorkspace((s) => s.presenter?.home ?? "");
  const show = useDisplayPath();
  const [name, setName] = useState("");
  const [parent, setParent] = useState(home ? joinPath(home, DEFAULT_PARENT_NAME) : "");
  const [folder, setFolder] = useState("");
  const folderTouched = useRef(false);
  const [kind, setKind] = useState<WorkspaceKind>(WorkspaceKind.KindStandard);
  const [baseline, setBaseline] = useState("");
  const [present, setPresent] = useState(false);
  const presentTouched = useRef(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; hint?: string } | null>(null);
  const [touched, setTouched] = useState(false);

  // The parent is remembered between sessions.
  useEffect(() => {
    let alive = true;
    void SettingsService.ModuleState(MODULE_STATE_ID)
      .then((raw) => {
        if (!alive || !raw) return;
        try {
          const st = JSON.parse(raw) as Remembered;
          if (st.parent) setParent(st.parent);
        } catch {
          /* ignore a broken state */
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const shownFolder = folderTouched.current ? folder : defaultFolder(parent, name);
  const errors = useMemo(() => validateNewWorkspace({ name, folder: shownFolder, baseline }), [name, shownFolder, baseline]);
  const invalid = Object.keys(errors).length > 0;

  const pickFolder = async () => {
    const dir = await FilesService.PickFolder("Choose the workspace folder").catch(() => "");
    if (dir) {
      folderTouched.current = true;
      setFolder(dir);
    }
  };
  const pickBaseline = async () => {
    const dir = await FilesService.PickFolder("Choose the folder to start from").catch(() => "");
    if (dir) setBaseline(dir);
  };

  const changeKind = (k: WorkspaceKind) => {
    setKind(k);
    if (!presentTouched.current) setPresent(k === WorkspaceKind.KindDemo);
  };

  const create = async () => {
    setTouched(true);
    if (invalid) return;
    setSaving(true);
    setServerError(null);
    try {
      const info = await WorkspacesService.Create({ name: name.trim(), root: shownFolder.trim(), kind, baseline: baseline.trim(), present });
      const nextParent = dirname(shownFolder.trim());
      if (nextParent) void SettingsService.SetModuleState(MODULE_STATE_ID, JSON.stringify({ parent: nextParent } satisfies Remembered)).catch(() => undefined);
      onDone();
      onClose();
      toast({ tone: "success", title: `Created ${info.name}` });
      // Create writes the folder; opening it relaunches Toolbox there.
      await switchTo(info.id);
    } catch (e) {
      const err = toAppError(e);
      setServerError({ message: err.message, hint: err.hint });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New workspace" confirmLabel={saving ? "Creating…" : "Create and open"} confirmDisabled={saving} onConfirm={() => void create()} onClose={onClose} wide>
      <div className={styles.form}>
        <Field label="Name" error={touched ? errors.name : undefined}>
          {(c) => (
            <TextField
              {...c}
              value={name}
              placeholder="Demo"
              maxLength={NAME_MAX + 10}
              onChange={(e) => setName(e.target.value)}
              data-tip="The name shown in the sidebar and the window title (1 to 40 characters)"
            />
          )}
        </Field>
        <Field label="Folder" hint={`Next to the parent folder ${show(parent) || "(choose one)"}`} error={touched ? errors.folder : undefined}>
          {(c) => (
            <TextField
              {...c}
              mono
              value={shownFolder}
              placeholder="Pick or type a folder"
              onChange={(e) => {
                folderTouched.current = true;
                setFolder(e.target.value);
              }}
              data-tip="Where the workspace lives. Its library is the Library folder inside it"
              trailing={
                <Button size="sm" variant="ghost" data-tip="Choose the folder in a file dialog" onClick={() => void pickFolder()}>
                  Browse…
                </Button>
              }
            />
          )}
        </Field>
        <Field label="Kind">
          {(c) => (
            <Select<WorkspaceKind>
              {...c}
              value={kind}
              onChange={changeKind}
              options={[
                { value: WorkspaceKind.KindStandard, label: "Standard" },
                { value: WorkspaceKind.KindDemo, label: "Demo (can be tidied and restored)" },
              ]}
            />
          )}
        </Field>
        <Field label="Start from a folder (optional)" hint="Its files are copied into the new library. The folder itself is never changed.">
          {(c) => (
            <TextField
              {...c}
              mono
              value={baseline}
              placeholder="No starting folder"
              onChange={(e) => setBaseline(e.target.value)}
              data-tip="A folder of files to copy into the workspace's library when it first opens"
              trailing={
                <Button size="sm" variant="ghost" data-tip="Choose the starting folder in a file dialog" onClick={() => void pickBaseline()}>
                  Browse…
                </Button>
              }
            />
          )}
        </Field>
        <Switch
          checked={present}
          onChange={(on) => {
            presentTouched.current = true;
            setPresent(on);
          }}
          label="Hide personal details"
          tip="Show folders as Name/… or ~/… and keep your user name off screen. On for Demo"
        />
        {serverError && (
          <Banner tone="danger" title={serverError.message}>
            {serverError.hint}
          </Banner>
        )}
      </div>
    </Modal>
  );
}
