import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Button, Icon, SegmentedControl, Spinner, TextField, toast } from "@/components";
import { FocusService, FilesService, type FocusAllowRule, type FocusApp } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isMac } from "@/lib/platform";
import { AppIcon, seedAppIcon } from "./AppIcon";
import { ruleFor, samePath, type RuleKind } from "./rules";
import type { AppPickerProps, AppPickerTab } from "./types";
import styles from "./AppPicker.module.css";

const TABS: ReadonlyArray<{ id: AppPickerTab; label: string }> = [
  { id: "installed", label: "Installed" },
  { id: "running", label: "Running" },
  { id: "browse", label: "Browse" },
];

const KIND_OPTIONS = [
  { value: "folder" as RuleKind, label: "Folder", tip: "Allow everything in the app's folder, so updates and helpers keep working" },
  { value: "exe" as RuleKind, label: "Program", tip: "Allow only this one program" },
];

interface TabData {
  apps: FocusApp[];
  loading: boolean;
  error: string;
  loaded: boolean;
}

const EMPTY: TabData = { apps: [], loading: false, error: "", loaded: false };

function report(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

/** Dialog that picks programs: Installed / Running / Browse (SPEC §4.3, §5.1). */
export function AppPicker({ open, onClose, mode, multiple, chosen, initialTab = "installed", onPickRules, onPickApp, title }: AppPickerProps): ReactElement | null {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<AppPickerTab>(initialTab);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Record<"installed" | "running", TabData>>({ installed: EMPTY, running: EMPTY });
  const [browsed, setBrowsed] = useState<FocusApp[]>([]);
  const [picked, setPicked] = useState<Record<string, FocusApp>>({});
  const [kinds, setKinds] = useState<Record<string, RuleKind>>({});

  const many = mode === "rule" && multiple !== false;
  const heading = title ?? (mode === "rule" ? "Add app" : "Choose an app");

  // Reset whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setQuery("");
    setPicked({});
    setKinds({});
    setBrowsed([]);
    setData({ installed: EMPTY, running: EMPTY });
  }, [open, initialTab]);

  const load = useCallback(async (which: "installed" | "running") => {
    setData((d) => ({ ...d, [which]: { ...d[which], loading: true, error: "" } }));
    try {
      const list = (await (which === "installed" ? FocusService.Apps() : FocusService.Running())) ?? [];
      for (const a of list) seedAppIcon(a.path, a.icon);
      setData((d) => ({ ...d, [which]: { apps: list, loading: false, error: "", loaded: true } }));
    } catch (e) {
      setData((d) => ({ ...d, [which]: { apps: [], loading: false, error: toAppError(e).message, loaded: true } }));
    }
  }, []);

  useEffect(() => {
    if (!open || tab === "browse") return;
    const cur = data[tab];
    if (!cur.loaded && !cur.loading) void load(tab);
  }, [open, tab, data, load]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open, tab]);

  const source: FocusApp[] = tab === "browse" ? browsed : data[tab].apps;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return source;
    return source.filter((a) => a.label.toLowerCase().includes(q) || a.path.toLowerCase().includes(q));
  }, [source, query]);

  if (!open) return null;

  const isChosen = (a: FocusApp) => (chosen ?? []).some((c) => samePath(c, a.path) || samePath(c, a.rule.path));

  const toggle = (a: FocusApp) => {
    if (isChosen(a)) return;
    setPicked((cur) => {
      if (cur[a.path]) {
        const { [a.path]: _gone, ...rest } = cur;
        return rest;
      }
      return many ? { ...cur, [a.path]: a } : { [a.path]: a };
    });
  };

  const pickedList = Object.values(picked);

  const confirm = (list: FocusApp[] = pickedList) => {
    if (list.length === 0) return;
    if (mode === "rule") {
      const rules: FocusAllowRule[] = list.map((a) => ruleFor(a, kinds[a.path] ?? (a.rule.kind === "exe" ? "exe" : "folder")));
      onPickRules?.(rules);
    } else {
      onPickApp?.(list[0]!);
    }
    onClose();
  };

  const addBrowsed = async (path: string) => {
    try {
      const app = await FocusService.AppFor(path);
      seedAppIcon(app.path, app.icon);
      setBrowsed((cur) => (cur.some((x) => samePath(x.path, app.path)) ? cur : [...cur, app]));
      if (!isChosen(app)) setPicked((cur) => (many ? { ...cur, [app.path]: app } : { [app.path]: app }));
    } catch (e) {
      report(e);
    }
  };

  const browseProgram = async () => {
    try {
      const files = (await FilesService.PickWith("Choose a program", isMac ? ["app"] : ["exe"], false)) ?? [];
      if (files[0]) await addBrowsed(files[0]);
    } catch (e) {
      report(e);
    }
  };

  const browseFolder = async () => {
    try {
      const dir = await FilesService.PickFolder("Choose the app's folder");
      if (dir) await addBrowsed(dir);
    } catch (e) {
      report(e);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && pickedList.length > 0) {
      e.preventDefault();
      confirm();
    }
  };

  const cur = tab === "browse" ? null : data[tab];
  const emptyText = tab === "browse" ? "Choose a program or a folder to add it here." : tab === "running" ? "No other programs with a window are running." : "No installed programs found.";
  const confirmLabel = mode === "rule" ? (pickedList.length > 1 ? `Add ${pickedList.length} apps` : "Add") : "Choose";
  const confirmBlocker = pickedList.length === 0 ? "Pick an app first" : "";

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div ref={panelRef} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            {heading}
          </h2>
          <div role="tablist" aria-label="Where to look" className={styles.tabs}>
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={styles.tab} data-active={tab === t.id ? "" : undefined} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {tab === "browse" ? (
          <div className={styles.browseBar}>
            <Button size="sm" icon="app-window" onClick={() => void browseProgram()} data-tip="Pick a program file">
              Program…
            </Button>
            <Button size="sm" icon="folder-open" onClick={() => void browseFolder()} data-tip="Pick an app's folder">
              Folder…
            </Button>
          </div>
        ) : (
          <TextField ref={searchRef} icon="search" size="sm" placeholder="Search" aria-label="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}

        <div className={styles.list} role="listbox" aria-label={TABS.find((t) => t.id === tab)?.label} aria-multiselectable={many || undefined}>
          {cur?.loading && (
            <div className={styles.note}>
              <Spinner size={14} label="Loading" /> Looking for programs…
            </div>
          )}
          {cur?.error && (
            <div className={styles.note} role="alert">
              {cur.error}
              <Button size="sm" variant="ghost" onClick={() => void load(tab as "installed" | "running")}>
                Retry
              </Button>
            </div>
          )}
          {!cur?.loading && !cur?.error && shown.length === 0 && <div className={styles.note}>{query ? "Nothing matches that search." : emptyText}</div>}
          {shown.map((a) => {
            const already = isChosen(a);
            const on = already || Boolean(picked[a.path]);
            const kind: RuleKind = kinds[a.path] ?? (a.rule.kind === "exe" ? "exe" : "folder");
            return (
              <div key={a.path} className={styles.row} role="option" aria-selected={on} aria-disabled={already || undefined} data-on={on ? "" : undefined}>
                <button
                  type="button"
                  className={styles.rowMain}
                  aria-disabled={already || undefined}
                  data-tip={already ? "Already added" : undefined}
                  onClick={() => toggle(a)}
                  onDoubleClick={() => {
                    if (!already && !many) confirm([a]);
                  }}
                >
                  <span className={styles.check} aria-hidden="true">
                    {on && <Icon name="check" size={12} />}
                  </span>
                  <AppIcon path={a.path} label={a.label} />
                  <span className={styles.label}>{a.label}</span>
                  <span className={styles.path}>{mode === "rule" ? ruleFor(a, kind).path : a.path}</span>
                </button>
                {mode === "rule" && on && !already && (
                  <SegmentedControl
                    size="sm"
                    aria-label={`${a.label} rule type`}
                    value={kind}
                    options={KIND_OPTIONS}
                    onChange={(k) => setKinds((cur2) => ({ ...cur2, [a.path]: k }))}
                  />
                )}
                {already && <span className={styles.added}>Added</span>}
              </div>
            );
          })}
        </div>

        <div className={styles.footer}>
          <Button variant="secondary" onClick={onClose} data-tip="Close without adding" data-tip-kbd="Esc">
            Cancel
          </Button>
          <Button variant="primary" disabled={confirmBlocker !== ""} data-tip={confirmBlocker || undefined} onClick={() => confirm()}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
