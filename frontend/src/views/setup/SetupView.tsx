import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, IconButton, PathText, Tooltip, cx, toast } from "@/components";
import { PacksService, type DiskInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isMac } from "@/lib/platform";
import { isActive, useJobs } from "@/state/jobs";
import { useLatestPackJobs, usePacks } from "@/state/packs";
import { useSettings } from "@/state/settings";
import { useUI } from "@/state/ui";
import { DiskBar, diskWarning } from "./DiskBar";
import { PackCard } from "./PackCard";
import { PackIcon } from "./PackIcon";
import { deriveProgress, isFinished } from "./packRun";
import { formatSize, initialSelection, isSelectable, packSizes } from "./packSizes";
import styles from "./SetupView.module.css";

const BUILTIN: Array<{ icon: string; name: string }> = [
  { icon: "clipboard", name: "Clipboard History" },
  { icon: "file-text", name: "PDF Toolkit" },
  { icon: "lock", name: "Vault" },
];

/** Marks setup done in the backend and in the local settings store. */
export async function finishSetup(): Promise<void> {
  try {
    await PacksService.FinishSetup();
  } catch (e) {
    toast({ tone: "danger", title: toAppError(e).message });
  }
  const s = useSettings.getState().settings;
  useSettings.getState().set({ ...s, setup: { ...s.setup, done: true } });
}

export interface SetupViewProps {
  /** Reopened from Settings: sits over the shell and has a close button. */
  overlay?: boolean;
  onClose?: () => void;
}

export function SetupView({ overlay = false, onClose }: SetupViewProps) {
  const packs = usePacks((s) => s.list);
  const loaded = usePacks((s) => s.loaded);
  const toolsDir = usePacks((s) => s.toolsDir);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [run, setRun] = useState<{ ids: string[]; since: number } | null>(null);
  const [location, setLocation] = useState("");
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [queuing, setQueuing] = useState(false);
  const jobs = useLatestPackJobs(run?.since ?? 0);

  // Initial selection, once packs are known.
  useEffect(() => {
    if (loaded && selected === null) setSelected(initialSelection(packs));
  }, [loaded, packs, selected]);

  // Reopened mid-install (for example after the restart for a new tools folder):
  // pick up the packs that already have an active install job.
  useEffect(() => {
    if (run || !loaded) return;
    const active = packs.filter((p) => {
      const j = jobs[p.id];
      return j && isActive(j);
    });
    if (active.length > 0) {
      setRun({ ids: active.map((p) => p.id), since: Math.min(...active.map((p) => jobs[p.id]?.createdAt ?? 0)) - 1 });
    }
  }, [run, loaded, packs, jobs]);

  const effectiveLocation = location || toolsDir?.path || "";
  useEffect(() => {
    let cancelled = false;
    PacksService.Disk(location)
      .then((d) => {
        if (!cancelled) setDisk(d);
      })
      .catch(() => {
        if (!cancelled) setDisk(null);
      });
    return () => {
      cancelled = true;
    };
  }, [location]);

  const installing = run !== null;
  const selectedIds = useMemo(() => selected ?? [], [selected]);
  const sizes = useMemo(() => packSizes(packs, selectedIds), [packs, selectedIds]);
  const orderedSelected = useMemo(() => packs.filter((p) => selectedIds.includes(p.id) && isSelectable(p)).map((p) => p.id), [packs, selectedIds]);
  const n = orderedSelected.length;
  const warning = disk ? diskWarning(disk.free, sizes.totalDisk) : "none";
  const canInstall = n > 0 && warning !== "full" && !queuing && !installing;

  const toggle = (id: string) =>
    setSelected((cur) => {
      const list = cur ?? [];
      return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    });

  const submit = useCallback(
    async (ids: string[], first: boolean) => {
      setQueuing(true);
      const dir = toolsDir && effectiveLocation !== toolsDir.path ? effectiveLocation : "";
      if (first) setRun({ ids, since: Date.now() - 1000 });
      try {
        const res = await PacksService.Install(ids, dir);
        for (const j of res.jobs ?? []) useJobs.getState().upsert(j);
        if (res.restart) await PacksService.Relaunch();
      } catch (e) {
        toast({ tone: "danger", title: toAppError(e).message, description: toAppError(e).hint });
        if (first) setRun(null);
      } finally {
        setQueuing(false);
      }
    },
    [toolsDir, effectiveLocation],
  );

  const install = useCallback(() => {
    if (canInstall) void submit(orderedSelected, true);
  }, [canInstall, orderedSelected, submit]);

  // Ctrl/Cmd+Enter installs from anywhere; Escape closes the overlay.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        install();
      } else if (e.key === "Escape" && overlay && onClose) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [install, overlay, onClose]);

  const pick = async () => {
    try {
      const p = await PacksService.PickToolsDir();
      if (p) setLocation(p);
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message, description: toAppError(e).hint });
    }
  };

  // Rail: scroll state, wheel-to-horizontal and arrow-key focus.
  const rail = useRef<HTMLDivElement>(null);
  const hits = useRef<Array<HTMLButtonElement | null>>([]);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const r = rail.current;
    if (!r) return;
    setEdges({ left: r.scrollLeft > 4, right: r.scrollLeft + r.clientWidth < r.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    const r = rail.current;
    if (!r) return;
    measure();
    const onWheel = (e: WheelEvent) => {
      if (r.scrollWidth <= r.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      r.scrollLeft += e.deltaY;
    };
    r.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(r);
    return () => {
      r.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [measure, packs.length]);
  const scrollBy = (dir: 1 | -1) => rail.current?.scrollBy?.({ left: dir * 272, behavior: "smooth" });
  const onHitKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const el = hits.current[i + (e.key === "ArrowRight" ? 1 : -1)];
    if (!el) return;
    el.focus();
    el.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  };

  // Installing state.
  const runPacks = useMemo(() => (run ? packs.filter((p) => run.ids.includes(p.id)) : []), [run, packs]);
  const statuses = runPacks.map((p) => deriveProgress(p, jobs[p.id]).status);
  const finishedCount = statuses.filter(isFinished).length;
  const allFinished = installing && runPacks.length > 0 && finishedCount === runPacks.length;
  const failedCount = statuses.filter((s) => s === "failed" || s === "cancelled").length;

  const openToolbox = async () => {
    const donePack = runPacks.find((p) => deriveProgress(p, jobs[p.id]).status === "done");
    await finishSetup();
    const target = donePack?.unlocks[0]?.moduleId;
    if (target) useUI.getState().navigate(target);
    onClose?.();
  };
  const skip = async () => {
    if (overlay) {
      onClose?.();
      return;
    }
    await finishSetup();
    useUI.getState().navigate("library");
  };
  const background = async () => {
    await finishSetup();
    onClose?.();
  };

  const installLabel =
    n > 0 ? (
      <>
        {`Install ${n} pack${n > 1 ? "s" : ""} · `}
        <span className={styles.total}>{formatSize(sizes.totalDisk)}</span>
      </>
    ) : (
      "Install"
    );

  return (
    <div className={cx(styles.root, overlay && styles.overlay)} role={overlay ? "dialog" : undefined} aria-label="Set up Toolbox" aria-modal={overlay || undefined}>
      <div className={cx(styles.scroll, isMac && styles.drag)}>
        <div className={styles.page}>
          {overlay && onClose ? (
            <IconButton className={styles.close} icon="x" label="Close setup" kbd="Escape" onClick={onClose} />
          ) : null}
          <header>
            <p className={styles.eyebrow}>Welcome to Toolbox</p>
            <h1 className={styles.title}>Which tool packs do you want?</h1>
            <p className={styles.lede}>
              Each pack downloads its own engines and models. Pick what you need now; you can add or remove packs any time in Settings.
            </p>
          </header>

          <div className={styles.builtin}>
            <span>Always included</span>
            {BUILTIN.map((b) => (
              <span key={b.name} className={styles.chip}>
                <PackIcon name={b.icon} size={12} />
                {b.name}
              </span>
            ))}
          </div>

          <div className={styles.railWrap}>
            {edges.left ? (
              <IconButton className={cx(styles.chev, styles.chevLeft)} variant="secondary" icon="chevron-left" label="Scroll left" onClick={() => scrollBy(-1)} />
            ) : null}
            <div ref={rail} className={styles.rail} onScroll={measure} role="group" aria-label="Tool packs">
              {packs.map((p, i) => {
                const progress = installing && run?.ids.includes(p.id) ? deriveProgress(p, jobs[p.id]) : undefined;
                const job = jobs[p.id];
                if (progress) {
                  if (progress.status === "running" || progress.status === "waiting") {
                    if (job) progress.onCancel = () => void useJobs.getState().cancel(job.id).catch(() => undefined);
                  } else if (progress.status === "failed" || progress.status === "cancelled") {
                    progress.onRetry = () => void submit([p.id], false);
                  }
                }
                return (
                  <PackCard
                    key={p.id}
                    pack={p}
                    size={sizes.byPack[p.id] ?? { download: 0, disk: 0, components: {} }}
                    mode="select"
                    selected={selectedIds.includes(p.id)}
                    locked={installing}
                    onToggle={() => toggle(p.id)}
                    progress={progress}
                    hitRef={(el) => {
                      hits.current[i] = el;
                    }}
                    onHitKeyDown={(e) => onHitKey(e, i)}
                  />
                );
              })}
            </div>
            {edges.right ? (
              <>
                <div className={styles.fade} aria-hidden="true" />
                <IconButton className={cx(styles.chev, styles.chevRight)} variant="secondary" icon="chevron-right" label="Scroll right" onClick={() => scrollBy(1)} />
              </>
            ) : null}
          </div>

          <DiskBar
            disk={disk}
            add={sizes.totalDisk}
            location={
              <span className={styles.location}>
                <PackIcon name="hard-drive" size={14} />
                <PathText path={effectiveLocation} className={styles.path} />
                {toolsDir?.fromEnv ? (
                  <span className={styles.fromEnv}>Set by TOOLBOX_TOOLS_DIR</span>
                ) : (
                  <Button size="sm" variant="ghost" disabled={installing} onClick={() => void pick()}>
                    Change…
                  </Button>
                )}
              </span>
            }
          />
        </div>
      </div>

      <footer className={styles.footer}>
        {installing ? (
          <span className={styles.note} role="status">
            {allFinished
              ? failedCount > 0
                ? `${failedCount} pack${failedCount > 1 ? "s" : ""} didn't finish`
                : "All packs installed"
              : `Installing ${Math.min(runPacks.length, finishedCount + 1)} of ${runPacks.length}`}
          </span>
        ) : (
          <span className={styles.note}>
            <PackIcon name="shield-check" size={14} />
            Everything downloads from each project's official releases and is checked against a pinned checksum.
          </span>
        )}
        <span className={styles.spacer} />
        {installing ? (
          allFinished ? (
            <Button variant="primary" className={styles.primary} onClick={() => void openToolbox()}>
              Open Toolbox
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => void background()}>
              Continue in background
            </Button>
          )
        ) : (
          <>
            <Button variant="ghost" onClick={() => void skip()}>
              Skip for now
            </Button>
            <Tooltip label={n > 0 ? `${formatSize(sizes.totalDownload)} to download` : "Select at least one pack"}>
              <Button variant="primary" icon="download" className={styles.primary} disabled={!canInstall} loading={queuing} onClick={install}>
                {installLabel}
              </Button>
            </Tooltip>
          </>
        )}
      </footer>
    </div>
  );
}
