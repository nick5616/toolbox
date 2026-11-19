import { useEffect, useRef, useState } from "react";
import { Badge, ConfirmDialog, Icon, cx, toast } from "@/components";
import { WorkspaceKind, type WorkspaceInfo } from "@/lib/api";
import { openNewWorkspace, openWorkspaceSettings, switchTo, useWorkspace, workspaceDot, workspaceIcon } from "@/state/workspace";
import styles from "./WorkspaceChip.module.css";

/** Why a workspace can't be opened right now. */
export const MISSING_REASON = "This workspace's folder isn't there. Plug the drive back in, or remove it from the list in Settings → Workspaces.";

/** The chip's contents (icon, name, dot or sandbox badge). */
function ChipFace({ info, collapsed }: { info: WorkspaceInfo; collapsed: boolean }) {
  const dot = workspaceDot(info);
  return (
    <>
      <Icon name={workspaceIcon(info)} size={16} />
      {!collapsed && <span className={styles.name}>{info.name}</span>}
      {!collapsed && dot && <span className={cx(styles.dot, styles[dot])} data-testid="workspace-dot" aria-hidden="true" />}
      {!collapsed && info.kind === WorkspaceKind.KindSandbox && (
        <Badge tone="warn" tip="This is a development sandbox, separate from your real workspaces">
          sandbox
        </Badge>
      )}
      {!collapsed && <Icon name="chevron-down" size={12} className={styles.caret} />}
    </>
  );
}

/** The workspace chip at the top of the sidebar (Phase 21, SPEC A1). */
export function WorkspaceChip({ collapsed }: { collapsed: boolean }) {
  const current = useWorkspace((s) => s.current);
  const list = useWorkspace((s) => s.list);
  const request = useWorkspace((s) => s.switchRequest);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = pos !== null;
  const notice = useWorkspace((s) => s.notice);

  // A boot message ("Demo's folder isn't there, opened Personal"): once, then cleared.
  useEffect(() => {
    if (!notice) return;
    toast({ tone: "warn", title: notice });
    useWorkspace.getState().clearNotice();
  }, [notice]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPos(null);
        btn.current?.focus();
      }
    };
    window.addEventListener("pointerdown", close);
    const onBlur = () => setPos(null);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open]);

  if (!current) return null;
  const choose = (w: WorkspaceInfo) => {
    setPos(null);
    if (w.current) return;
    void switchTo(w.id);
  };
  const toggle = () => {
    if (open) return setPos(null);
    const r = btn.current?.getBoundingClientRect();
    setPos({ left: r ? r.left : 8, top: r ? r.bottom + 4 : 48 });
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };
  const tipText = `Workspace: ${current.name}. Each workspace has its own library, history and settings`;

  return (
    <div className={cx(styles.wrap, collapsed && styles.collapsed)}>
      <button
        ref={btn}
        type="button"
        className={styles.chip}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={collapsed ? `Workspace: ${current.name}` : undefined}
        data-tip={collapsed ? tipText : "Switch workspace or manage them"}
        data-tip-side="right"
        data-testid="workspace-chip"
        onClick={toggle}
      >
        <ChipFace info={current} collapsed={collapsed} />
      </button>
      {pos && (
        <div ref={menu} className={styles.menu} role="menu" aria-label="Workspaces" style={{ left: pos.left, top: pos.top }} onKeyDown={onMenuKey}>
          {list.map((w) => {
            const disabled = w.missing;
            return (
              <button
                key={w.id}
                type="button"
                role="menuitemradio"
                aria-checked={w.current}
                aria-disabled={disabled || undefined}
                className={styles.item}
                data-tip={disabled ? MISSING_REASON : w.current ? "You are in this workspace" : `Quit and reopen Toolbox in ${w.name}`}
                data-tip-side="right"
                onClick={() => (disabled ? undefined : choose(w))}
              >
                <span className={styles.check}>{w.current && <Icon name="check" size={14} />}</span>
                <span className={styles.itemName}>{w.name}</span>
                {workspaceDot(w) && <span className={cx(styles.dot, styles[workspaceDot(w) ?? "accent"])} aria-hidden="true" />}
                {w.missing && <span className={styles.missing}>Missing</span>}
              </button>
            );
          })}
          <hr className={styles.sep} />
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            data-tip="Make a new workspace with its own library and settings"
            data-tip-side="right"
            onClick={() => {
              setPos(null);
              openNewWorkspace();
            }}
          >
            <span className={styles.check}>
              <Icon name="plus" size={14} />
            </span>
            <span className={styles.itemName}>New workspace…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            data-tip="Rename, add or remove workspaces in Settings"
            data-tip-side="right"
            onClick={() => {
              setPos(null);
              openWorkspaceSettings();
            }}
          >
            <span className={styles.check}>
              <Icon name="settings" size={14} />
            </span>
            <span className={styles.itemName}>Manage workspaces…</span>
          </button>
        </div>
      )}
      <ConfirmDialog
        open={request !== null}
        title={`Switch to ${request?.name ?? ""}?`}
        body="Toolbox will close and reopen in that workspace. Unsaved work is saved first."
        confirmLabel="Switch"
        onCancel={() => useWorkspace.getState().requestSwitch(null)}
        onConfirm={() => {
          const id = request?.id;
          useWorkspace.getState().requestSwitch(null);
          if (id) {
            void switchTo(id);
          }
        }}
      />
    </div>
  );
}
