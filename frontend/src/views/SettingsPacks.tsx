import { useEffect, useMemo, useState } from "react";
import { Banner, Button, ConfirmDialog, PathText, Section, toast } from "@/components";
import { DepSource, DepState, DepsService, JobStatus, PacksService, PackState, type DiskInfo, type Job, type PackRemovePreview } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useDeps, type DepView } from "@/state/deps";
import { isActive, useJobs } from "@/state/jobs";
import { TOOLS_MOVE_MODULE, useLatestPackJobs, usePacks } from "@/state/packs";
import { useUI } from "@/state/ui";
import { PackCard, type PackProgress } from "./setup/PackCard";
import { deriveProgress } from "./setup/packRun";
import { formatSize, packSizes, type PackView } from "./setup/packSizes";
import styles from "./SettingsPacks.module.css";

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "This frees 311 MB. The AI engine stays because Music uses it." */
export function removeBody(p: PackRemovePreview): string {
  const kept = (p.kept ?? []).map((k) => `${k.component} stays because ${joinNames(k.usedBy ?? [])} ${(k.usedBy ?? []).length > 1 ? "use" : "uses"} it.`);
  return [`This frees ${formatSize(p.freedBytes)}.`, ...kept].join(" ");
}

const MANAGED_DEPS: Record<string, { jobModule: string; install: () => Promise<Job>; remove: () => Promise<void>; name: string }> = {
  ffmpeg: { name: "FFmpeg", jobModule: "system-ffmpeg-install", install: () => DepsService.InstallFFmpeg(), remove: () => DepsService.RemoveFFmpeg() },
  deno: { name: "Deno", jobModule: "system-deno-install", install: () => DepsService.InstallDeno(), remove: () => DepsService.RemoveDeno() },
};

/** True for dependency IDs whose Install/Update/Remove actions are rendered by ManagedDepActions. */
export function isManagedDep(id: string): boolean {
  return Object.hasOwn(MANAGED_DEPS, id);
}

/** Install / Update / Remove for the managed FFmpeg and Deno (a system copy then takes over on Remove). */
export function ManagedDepActions({ dep }: { dep: DepView }) {
  const cfg = MANAGED_DEPS[dep.id];
  const busy = useJobs((s) => Object.values(s.byId).some((j) => j.moduleId === cfg?.jobModule && isActive(j)));
  const [queuing, setQueuing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (!cfg) return null;
  const managed = dep.source === DepSource.SourceManaged && dep.state !== DepState.DepMissing;

  const install = async () => {
    setQueuing(true);
    try {
      useJobs.getState().upsert(await cfg.install());
      toast({ title: `${cfg.name} install queued` });
    } catch (e) {
      fail(e);
    } finally {
      setQueuing(false);
    }
  };
  const remove = async () => {
    setConfirm(false);
    try {
      await cfg.remove();
      toast({ title: `${cfg.name} removed` });
      await useDeps.getState().recheck();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <span className={styles.actionGroup}>
      <Button size="sm" variant="secondary" loading={queuing || busy} onClick={() => void install()}>
        {managed ? "Update" : "Install"}
      </Button>
      {managed ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>
          Remove
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirm}
        tone="danger"
        title={`Remove ${cfg.name}?`}
        body={`Removes the copy Toolbox downloaded. A ${cfg.name} found on this computer is kept and used instead.`}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
        onCancel={() => setConfirm(false)}
      />
    </span>
  );
}

function ToolsFolder() {
  const toolsDir = usePacks((s) => s.toolsDir);
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const moveJob = useJobs((s) => {
    let best: (typeof s.byId)[string] | undefined;
    for (const j of Object.values(s.byId)) if (j.moduleId === TOOLS_MOVE_MODULE && (!best || j.createdAt >= best.createdAt)) best = j;
    return best;
  });

  useEffect(() => {
    let cancelled = false;
    PacksService.Disk("")
      .then((d) => {
        if (!cancelled) setDisk(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [toolsDir?.path]);

  const pick = async () => {
    try {
      const p = await PacksService.PickToolsDir();
      if (p) setPicked(p);
    } catch (e) {
      fail(e);
    }
  };
  const move = async () => {
    const dir = picked;
    setPicked("");
    setBusy(true);
    try {
      useJobs.getState().upsert(await PacksService.MoveToolsDir(dir));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const moving = !!moveJob && isActive(moveJob);
  const moved = moveJob?.status === JobStatus.JobDone;
  return (
    <div className={styles.folder}>
      <div className={styles.folderRow}>
        <span className={styles.folderLabel}>Tools folder</span>
        <PathText path={toolsDir?.path ?? ""} copy className={styles.folderPath} />
        {disk ? <span className={styles.free}>{formatSize(disk.free)} free</span> : null}
        {toolsDir?.fromEnv ? (
          <span className={styles.note}>Set by TOOLBOX_TOOLS_DIR</span>
        ) : (
          <Button size="sm" variant="secondary" loading={busy || moving} disabled={!toolsDir} onClick={() => void pick()}>
            Move…
          </Button>
        )}
      </div>
      {moving ? <p className={styles.note}>{moveJob?.message || "Moving the tools folder…"}</p> : null}
      {moved ? (
        <Banner
          tone="info"
          action={
            <Button size="sm" variant="primary" onClick={() => void PacksService.Relaunch().catch(fail)}>
              Restart now
            </Button>
          }
        >
          Restart Toolbox to use the new folder.
        </Banner>
      ) : null}
      <ConfirmDialog
        open={picked !== ""}
        title="Move the tools folder?"
        body={`Toolbox copies its engines and models to ${picked} and then asks you to restart. Wait for running jobs to finish first.`}
        confirmLabel="Move"
        onConfirm={() => void move()}
        onCancel={() => setPicked("")}
      />
    </div>
  );
}

export function SettingsPacks() {
  const packs = usePacks((s) => s.list);
  const jobs = useLatestPackJobs();
  const [queuing, setQueuing] = useState<string>("");
  const [removing, setRemoving] = useState<{ pack: PackView; preview: PackRemovePreview } | null>(null);

  const alone = useMemo(() => Object.fromEntries(packs.map((p) => [p.id, packSizes(packs, [p.id]).byPack[p.id]])), [packs]);

  const install = async (p: PackView) => {
    setQueuing(p.id);
    try {
      const res = await PacksService.Install([p.id], "");
      for (const j of res.jobs ?? []) useJobs.getState().upsert(j);
      if (res.restart) await PacksService.Relaunch();
    } catch (e) {
      fail(e);
    } finally {
      setQueuing("");
    }
  };
  const askRemove = async (p: PackView) => {
    try {
      setRemoving({ pack: p, preview: await PacksService.RemovePreview(p.id) });
    } catch (e) {
      fail(e);
    }
  };
  const remove = async () => {
    const r = removing;
    setRemoving(null);
    if (!r) return;
    try {
      await PacksService.Remove(r.pack.id);
      toast({ title: `${r.pack.name} pack removed` });
      await usePacks.getState().load();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div id="settings-packs">
      <Section
        label="Tool packs"
        action={
          <Button size="sm" variant="ghost" onClick={() => useUI.getState().navigate("setup")}>
            Show setup screen
          </Button>
        }
      >
        {packs.length === 0 ? (
          <p className={styles.note}>Loading tool packs…</p>
        ) : (
          <div className={styles.grid}>
            {packs.map((p) => {
              const job = jobs[p.id];
              const active = job && isActive(job);
              let progress: PackProgress | undefined;
              if (active || p.state === PackState.PackInstalling) {
                progress = deriveProgress(p, active ? job : undefined);
                if (active) progress.onCancel = () => void useJobs.getState().cancel(job.id).catch(() => undefined);
              }
              const installed = p.state === PackState.PackInstalled || p.state === PackState.PackOutdated || p.state === PackState.PackPartial;
              const canInstall = p.state === PackState.PackMissing || p.state === PackState.PackPartial;
              return (
                <PackCard
                  key={p.id}
                  pack={p}
                  size={alone[p.id] ?? { download: 0, disk: 0, components: {} }}
                  mode="manage"
                  progress={progress}
                  actions={
                    progress ? null : (
                      <>
                        {canInstall ? (
                          <Button size="sm" variant="secondary" icon="download" loading={queuing === p.id} onClick={() => void install(p)}>
                            Install
                          </Button>
                        ) : null}
                        {p.state === PackState.PackOutdated ? (
                          <Button size="sm" variant="primary" loading={queuing === p.id} onClick={() => void install(p)}>
                            Update
                          </Button>
                        ) : null}
                        {installed ? (
                          <Button size="sm" variant="ghost" onClick={() => void askRemove(p)}>
                            Remove
                          </Button>
                        ) : null}
                      </>
                    )
                  }
                />
              );
            })}
          </div>
        )}
        <ToolsFolder />
      </Section>
      <ConfirmDialog
        open={removing !== null}
        tone="danger"
        title={`Remove the ${removing?.pack.name ?? ""} pack?`}
        body={removing ? removeBody(removing.preview) : undefined}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
