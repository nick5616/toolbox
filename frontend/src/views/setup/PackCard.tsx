import { useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Browser } from "@wailsio/runtime";
import { Badge, Button, IconButton, Meter, Tooltip, cx } from "@/components";
import { PackState } from "@/lib/api";
import { PackIcon } from "./PackIcon";
import { formatSize, isSelectable, type PackSize, type PackView } from "./packSizes";
import styles from "./PackCard.module.css";

export type PackRunStatus = "waiting" | "running" | "done" | "failed" | "cancelled";

/** Per-card install progress (setup installing state and Settings). */
export interface PackProgress {
  status: PackRunStatus;
  /** 0..1, or -1 for indeterminate. */
  value: number;
  message: string;
  /** Failure message (failed). */
  error?: string;
  /** The AppError hint, shown as a tooltip. */
  hint?: string;
  onCancel?: () => void;
  onRetry?: () => void;
}

export interface PackCardProps {
  pack: PackView;
  size: PackSize;
  /** "select": setup screen toggle card. "manage": Settings card with actions. */
  mode: "select" | "manage";
  selected?: boolean;
  /** Setup is installing: cards stop toggling. */
  locked?: boolean;
  onToggle?: () => void;
  progress?: PackProgress;
  /** manage mode: Install / Update / Remove buttons. */
  actions?: ReactNode;
  hitRef?: Ref<HTMLButtonElement>;
  onHitKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

function openLink(e: React.MouseEvent, href: string) {
  e.preventDefault();
  e.stopPropagation();
  void Browser.OpenURL(href).catch(() => undefined);
}

/** Short hints that tell similarly named packs apart (names and ids come from the catalog). */
const PACK_KICKER: Record<string, string> = {
  music: "Audio tools",
  edit: "For Edit Studio",
};

function StateBadge({ pack, mode = "select" }: { pack: PackView; mode?: "select" | "manage" }) {
  switch (pack.state) {
    case PackState.PackInstalled:
      return <Badge tone="ok" tip="Everything in this pack is installed">Installed</Badge>;
    case PackState.PackOutdated:
      return <Badge tone="warn" tip="A newer version of something in this pack is available">Update available</Badge>;
    case PackState.PackPartial:
      // In Settings the "Install the rest (size)" button says it all.
      if (mode === "manage") return null;
      return <Badge tone="neutral" tip="Some parts are installed; install again to add the rest">Partly installed</Badge>;
    case PackState.PackUnsupported: {
      const badge = <Badge tone="neutral" tip="This pack does not run on your system">Not available on this computer</Badge>;
      return pack.unsupportedReason ? <Tooltip label={pack.unsupportedReason}>{badge}</Tooltip> : badge;
    }
    default:
      return null;
  }
}

function ComponentRow({ pack, size, id }: { pack: PackView; size: PackSize; id: string }) {
  const c = pack.components.find((x) => x.id === id);
  const cost = size.components[id];
  if (!c || !cost) return null;
  let amount: ReactNode;
  let cls = "";
  if (cost.kind === "with") {
    amount = `with ${cost.withPack ?? ""}`;
    cls = styles.shared ?? "";
  } else if (cost.kind === "system") {
    amount = "found on this PC";
    cls = styles.found ?? "";
  } else if (cost.kind === "installed") {
    amount = "installed";
    cls = styles.installedRow ?? "";
  } else if (cost.kind === "unsupported") {
    amount = "unavailable";
  } else {
    amount = formatSize(c.diskBytes);
  }
  return (
    <li className={cx(styles.part, cls)} data-state={c.state}>
      <a href={c.href} data-tip={`Open the ${c.name} project page in your browser`} className={styles.partLink} onClick={(e) => openLink(e, c.href)} rel="noreferrer">
        {c.name}
      </a>
      <span className={styles.license} data-tip="The software licence">{c.license}</span>
      <span className={styles.amount} data-tip={cost.kind === "with" ? `Already counted in the ${cost.withPack ?? "other"} pack you picked` : cost.kind === "system" ? "Already on your computer, so nothing to download" : cost.kind === "installed" ? "Already installed" : "Disk space this part uses once installed"}>
        {cost.kind === "installed" ? <PackIcon name="check" size={11} strokeWidth={3} /> : null}
        {cost.kind === "with" ? <s>{formatSize(c.diskBytes)}</s> : null}
        {amount}
      </span>
    </li>
  );
}

function Progress({ progress, packName }: { progress: PackProgress; packName: string }) {
  const { status } = progress;
  const meterStatus = status === "waiting" ? "queued" : status;
  let text = progress.message;
  if (status === "waiting") text = "Waiting";
  else if (status === "cancelled") text = "Cancelled";
  else if (status === "done") text = "Ready";
  else if (status === "failed") text = progress.error || "Install failed";
  const msg = status === "failed" && progress.hint ? <Tooltip label={progress.hint}>{<span>{text}</span>}</Tooltip> : text;
  return (
    <div className={styles.progress} data-status={status}>
      <div className={styles.progressRow}>
        <span className={cx(styles.progressMsg, status === "failed" && styles.failedMsg, status === "done" && styles.doneMsg)}>
          {msg}
        </span>
        {status === "running" || status === "waiting" ? (
          progress.onCancel ? (
            <IconButton size="sm" icon="x" label={`Cancel ${packName} install`} data-tip="Stop installing this pack" onClick={progress.onCancel} />
          ) : null
        ) : null}
        {(status === "failed" || status === "cancelled") && progress.onRetry ? (
          <Button size="sm" variant="secondary" data-tip="Try installing this pack again" onClick={progress.onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
      <Meter tip="Install progress for this pack" value={status === "done" ? 1 : progress.value} status={meterStatus} size="sm" label="Install progress" />
    </div>
  );
}

/** One tool pack: icon, state, live size, what it unlocks and downloads. */
export function PackCard({ pack, size, mode, selected = false, locked = false, onToggle, progress, actions, hitRef, onHitKeyDown }: PackCardProps) {
  const selectable = isSelectable(pack) && !locked;
  const present = pack.state === PackState.PackInstalled || pack.state === PackState.PackUnsupported;
  const showSize = pack.state !== PackState.PackInstalled && pack.state !== PackState.PackUnsupported;
  const on = selected && isSelectable(pack);
  const [open, setOpen] = useState(false);

  if (mode === "manage") {
    const detailsId = `pack-details-${pack.id}`;
    return (
      <article className={styles.row} data-pack={pack.id} data-state={pack.state} aria-label={`${pack.name} pack`}>
        <div className={styles.rowHead}>
          <button
            type="button"
            className={styles.rowToggle}
            aria-expanded={open}
            aria-controls={detailsId}
            data-tip={open ? "Hide what this pack unlocks and downloads" : "Show what this pack unlocks and downloads"}
            onClick={() => setOpen((v) => !v)}
          >
            <span className={cx(styles.chev, open && styles.chevOpen)} aria-hidden="true">
              <PackIcon name="chevron-right" size={12} />
            </span>
            <span className={styles.rowTile}>
              <PackIcon name={pack.icon} size={14} strokeWidth={1.75} />
            </span>
            <span className={styles.rowName} data-tip="A pack is a group of related tools">
              {pack.name}
              {PACK_KICKER[pack.id] ? <small className={styles.kicker}> · {PACK_KICKER[pack.id]}</small> : null}
            </span>
            {showSize ? (
              <span className={styles.rowSize} data-tip="Disk space once installed, and how much to download">
                {formatSize(size.disk)}
                <small> · {formatSize(size.download)} download</small>
              </span>
            ) : null}
          </button>
          <span className={styles.rowState}>
            <StateBadge pack={pack} mode="manage" />
          </span>
          {progress ? null : actions ? <div className={styles.rowActions}>{actions}</div> : null}
        </div>
        {progress ? <Progress progress={progress} packName={pack.name} /> : null}
        {open ? (
          <div id={detailsId} className={styles.rowDetails}>
            <p className={styles.desc}>{pack.description}</p>
            {pack.unlocks.length > 0 ? (
              <div>
                <div className={styles.label} data-tip="Tools that start working once this pack is installed">Unlocks</div>
                <ul className={styles.unlocksInline}>
                  {pack.unlocks.map((u) => (
                    <li key={u.moduleId}>
                      <PackIcon name={u.icon} size={13} />
                      {u.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <div className={styles.label} data-tip="Engines and models this pack installs, each with its licence and size">Downloads</div>
              <ul className={styles.parts}>
                {pack.components.map((c) => (
                  <ComponentRow key={c.id} pack={pack} size={size} id={c.id} />
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <article
      className={cx(styles.card, on && styles.selected, (present || (!selectable && !locked)) && styles.muted)}
      data-pack={pack.id}
      data-state={pack.state}
          >
      {(
        <button
          ref={hitRef}
          type="button"
          className={styles.hit}
          data-pack-card=""
          aria-label={pack.name}
          data-tip={selectable ? (selected ? `${pack.name} will be installed; click to leave it out` : `Click to include the ${pack.name} pack in the install`) : present ? "Already installed" : locked ? "Installing; choices are locked" : "Not available"}
          aria-pressed={isSelectable(pack) ? selected : undefined}
          aria-disabled={!selectable || undefined}
          onClick={() => {
            if (selectable) onToggle?.();
          }}
          onKeyDown={onHitKeyDown}
        />
      )}
      <div className={styles.content}>
        <div className={styles.head}>
          <span className={styles.tile}>
            <PackIcon name={pack.icon} size={22} strokeWidth={1.5} />
          </span>
          <span className={styles.headRight}>
            <StateBadge pack={pack} />
            {isSelectable(pack) ? (
              <span className={styles.check} aria-hidden="true">
                <PackIcon name="check" size={12} strokeWidth={3} />
              </span>
            ) : null}
          </span>
        </div>
        <div>
          <div className={styles.name} data-tip="A pack is a group of related tools">
            {pack.name}
            {PACK_KICKER[pack.id] ? <small className={styles.kicker}> · {PACK_KICKER[pack.id]}</small> : null}
          </div>
          {showSize ? (
            <div className={styles.size} data-tip="Disk space once installed, and how much to download">
              {formatSize(size.disk)}
              <small>· {formatSize(size.download)} download</small>
            </div>
          ) : null}
        </div>
        <div className={styles.body}>
          {pack.unlocks.length > 0 ? (
            <div>
              <div className={styles.label} data-tip="Tools that start working once this pack is installed">Unlocks</div>
              <ul className={styles.unlocks}>
                {pack.unlocks.map((u) => (
                  <li key={u.moduleId}>
                    <PackIcon name={u.icon} size={14} />
                    {u.name}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <div className={styles.label} data-tip="Engines and models this pack installs, each with its licence and size">Downloads</div>
            <ul className={styles.parts}>
              {pack.components.map((c) => (
                <ComponentRow key={c.id} pack={pack} size={size} id={c.id} />
              ))}
            </ul>
          </div>
        </div>
        <div className={styles.foot}>
          {progress ? <Progress progress={progress} packName={pack.name} /> : <p className={styles.desc}>{pack.description}</p>}
                  </div>
      </div>
    </article>
  );
}
