/**
 * Click-ins (Phase 10, SPEC.md §7b): a compact launcher that opens its
 * content in a drawer over the right side of the nearest <ClickInHost>, and
 * can pop that content out into its own window when it is a registered part.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "./toast";
import { toAppError } from "@/lib/errors";
import { focusWindow, partWindowKey, popOutPart } from "@/lib/windows";
import { getPart } from "@/parts/registry";
import { useWindowOpen } from "@/state/windows";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { cx } from "./cx";
import styles from "./ClickIn.module.css";

interface HostCtx {
  el: HTMLElement | null;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  /** "inline": click-ins open as disclosures in place (an embedded tool never opens a drawer in a drawer). */
  mode: "drawer" | "inline";
  /** 0 for a tool's host; n for click-ins opened from inside an open drawer (they stack over it, in the same host area). */
  depth: number;
  /** For the host inside a drawer: the host that drawer belongs to (useClickIn addresses it). */
  parent?: HostCtx;
}

const HostContext = createContext<HostCtx | null>(null);

/**
 * Open click-ins, innermost last. Esc closes only the top one: every open
 * click-in listens on `document` and the outer one registered first, so
 * without this stack Esc would close the outer drawer before the inner.
 */
const openStack: symbol[] = [];

export interface ClickInHostProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /**
   * "drawer" (default): click-ins slide over the host's right edge.
   * "inline": they expand in place under their launcher. A host without a
   * `mode` inherits "inline" from an enclosing inline host, so a tool's own
   * root host stays inline when the tool is embedded in another.
   */
  mode?: "drawer" | "inline";
}

/** The area drawers slide over (a tool's root). Drawers fill its height and live at its right edge. */
export function ClickInHost({ children, className, style, mode }: ClickInHostProps) {
  const parent = useContext(HostContext);
  const effective = mode ?? (parent?.mode === "inline" ? "inline" : "drawer");
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const ctx = useMemo<HostCtx>(() => ({ el, openId, setOpenId, mode: effective, depth: 0 }), [el, openId, effective]);
  return (
    <HostContext.Provider value={ctx}>
      <div ref={setEl} className={cx(styles.host, effective === "inline" && styles.hostInline, className)} style={style} data-click-in-host data-mode={effective}>
        {children}
      </div>
    </HostContext.Provider>
  );
}

/** Opens and closes the click-in drawer of the nearest host. Without a host these do nothing. */
export function useClickIn(): { open: (id: string) => void; close: () => void; isOpen: (id: string) => boolean; openId: string | null } {
  // Inside a drawer, this addresses the host the drawer belongs to (a panel closing itself, or switching to another panel).
  const inner = useContext(HostContext);
  const host = inner?.parent ?? inner;
  const setOpenId = host?.setOpenId;
  const open = useCallback((id: string) => setOpenId?.(id), [setOpenId]);
  const close = useCallback(() => setOpenId?.(null), [setOpenId]);
  const openId = host?.openId ?? null;
  return useMemo(() => ({ open, close, isOpen: (id: string) => openId === id, openId }), [open, close, openId]);
}

export interface ClickInProps {
  icon: string;
  title: string;
  /** Muted one-line state shown on the row ("2 on this clip"). */
  summary?: string;
  /** Tooltip text. */
  tip?: string;
  /** Id of a registered part: enables Pop out and the "open in its window" state. */
  part?: string;
  /** Part instance (window key suffix). */
  instance?: string;
  /** Extra URL params for the part window. */
  params?: Record<string, string>;
  /** Drawer id (defaults to `part`, else the title). */
  id?: string;
  variant?: "row" | "icon";
  /** A count shown on the launcher. */
  badge?: number;
  /** Drawer width in px (default 360; capped at 90 % of the host). */
  width?: number;
  /** No padding around the content: for content that pads itself (editor panels). */
  flush?: boolean;
  /** Size of the pop-out window (default: the part's own size). */
  popOutSize?: { width: number; height: number };
  /** A custom pop-out (Phase 11: <ToolClickIn> opens a whole tool window); shows the Pop out button without a `part`. */
  onPopOut?: () => void | Promise<void>;
  /** The launcher is shown but can't open (with the reason as its tooltip). */
  disabledReason?: string;
  /** No launcher: the drawer is opened from elsewhere with `useClickIn().open(id)` (the shell's constituent drawer). */
  headless?: boolean;
  children: ReactNode;
  className?: string;
}

const DEFAULT_WIDTH = 360;

/**
 * Click-ins inside an open drawer (a ToolClickIn in a panel, "Trim first" in
 * Subtitles' Source panel) open as a drawer stacked over it, in the same host
 * area and as wide as they ask; closing it shows the drawer beneath again.
 */
function NestedHost({ parent, children }: { parent: HostCtx; children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const ctx = useMemo<HostCtx>(() => ({ el: parent.el, openId, setOpenId, mode: "drawer", depth: parent.depth + 1, parent }), [parent, openId]);
  return <HostContext.Provider value={ctx}>{children}</HostContext.Provider>;
}

/** Whether a node is inside a drawer stacked above `depth`. */
function inDeeperDrawer(t: Node, depth: number): boolean {
  const el = t instanceof Element ? t : t.parentElement;
  const d = el?.closest("[data-click-in-depth]");
  return !!d && Number(d.getAttribute("data-click-in-depth")) > depth;
}

export function ClickIn({
  icon,
  title,
  summary,
  tip,
  part,
  instance,
  params,
  id,
  variant = "row",
  badge,
  width = DEFAULT_WIDTH,
  flush = false,
  popOutSize,
  onPopOut,
  disabledReason,
  headless = false,
  children,
  className,
}: ClickInProps) {
  const myId = id ?? part ?? title;
  const host = useContext(HostContext);
  const [localOpen, setLocalOpen] = useState<string | null>(null);
  const openId = host ? host.openId : localOpen;
  const setOpenId = host ? host.setOpenId : setLocalOpen;
  const isOpen = openId === myId;
  // Inline disclosures replace the drawer (the icon variant has no row to expand under, so it keeps the drawer).
  const inline = host?.mode === "inline" && variant === "row";

  const launcherRef = useRef<HTMLElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const spec = part ? getPart(part) : undefined;
  const windowKey = part ? partWindowKey(part, instance) : "";
  const windowOpen = useWindowOpen(windowKey);

  const close = useCallback(() => setOpenId(null), [setOpenId]);

  // Focus moves into the drawer, and back to the launcher when it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true;
      if (!inline) drawerRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      const a = document.activeElement;
      if (!a || a === document.body) launcherRef.current?.focus();
    }
  }, [isOpen, inline]);

  // Closing on unmount keeps a stale id from blocking the host's one drawer.
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  const setRef = useRef(setOpenId);
  setRef.current = setOpenId;
  useEffect(
    () => () => {
      if (openRef.current) setRef.current(null);
    },
    [],
  );

  // Esc closes the innermost open click-in; a click in the host outside a drawer closes it.
  const hostEl = host?.el ?? null;
  const depth = host?.depth ?? 0;
  useEffect(() => {
    if (!isOpen) return;
    const token = Symbol(myId);
    openStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && openStack[openStack.length - 1] === token) {
        e.preventDefault();
        close();
      }
    };
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (drawerRef.current?.contains(t) || launcherRef.current?.contains(t)) return;
      if (inDeeperDrawer(t, depth)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    const target = hostEl ?? document;
    if (!inline) target.addEventListener("pointerdown", onDown, true);
    return () => {
      const i = openStack.indexOf(token);
      if (i >= 0) openStack.splice(i, 1);
      document.removeEventListener("keydown", onKey);
      if (!inline) target.removeEventListener("pointerdown", onDown, true);
    };
  }, [isOpen, close, hostEl, myId, inline, depth]);

  const launch = () => {
    if (disabledReason) return;
    if (windowOpen) {
      focusWindow(windowKey).catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
      return;
    }
    setOpenId(isOpen ? null : myId);
  };

  const popOut = async () => {
    if (onPopOut) {
      try {
        await onPopOut();
        close();
      } catch (e) {
        toast({ tone: "danger", title: toAppError(e).message });
      }
      return;
    }
    if (!part) return;
    try {
      await popOutPart(part, {
        title: `${title || spec?.title || "Toolbox"} — Toolbox`,
        width: popOutSize?.width ?? spec?.width,
        height: popOutSize?.height ?? spec?.height,
        params,
        instance,
      });
      close();
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    }
  };

  const launcherTip = disabledReason || (windowOpen ? `${title} is open in its own window. Click to show it.` : (tip ?? title));
  const glyph = windowOpen ? "app-window" : icon;

  const launcher =
    variant === "icon" ? (
      <span className={cx(styles.iconWrap, className)}>
        <IconButton
          ref={(el) => {
            launcherRef.current = el;
          }}
          icon={glyph}
          label={windowOpen ? `${title} (open in its own window)` : title}
          data-tip={launcherTip}
          pressed={isOpen}
          disabled={!!disabledReason}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          onClick={launch}
        />
        {badge ? <span className={styles.badge}>{badge}</span> : null}
      </span>
    ) : (
      <button
        ref={(el) => {
          launcherRef.current = el;
        }}
        type="button"
        className={cx(styles.row, isOpen && styles.rowOpen, className)}
        disabled={!!disabledReason}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-tip={launcherTip}
        onClick={launch}
      >
        <Icon name={glyph} size={16} className={styles.rowIcon} />
        <span className={styles.rowTitle}>{title}</span>
        {summary ? <span className={styles.rowSummary}>{summary}</span> : null}
        {badge ? <span className={styles.badge}>{badge}</span> : null}
        <Icon name={windowOpen ? "app-window" : inline && isOpen ? "chevron-down" : "chevron-right"} size={14} className={styles.chevron} />
      </button>
    );

  const canPopOut = !!onPopOut || !!(part && spec);

  const inlinePanel =
    inline && isOpen ? (
      <div
        ref={(el) => {
          drawerRef.current = el;
        }}
        className={styles.inlinePanel}
        role="group"
        aria-label={title}
      >
        {canPopOut ? (
          <div className={styles.inlineBar}>
            <IconButton size="sm" icon="picture-in-picture-2" label="Pop out" data-tip="Open this in its own window" onClick={() => void popOut()} />
          </div>
        ) : null}
        <div className={cx(styles.inlineBody, flush && styles.flush)}>{children}</div>
      </div>
    ) : null;

  const drawer = isOpen && !inline ? (
    <aside
      ref={(el) => {
        drawerRef.current = el;
      }}
      className={cx(styles.drawer, !hostEl && styles.fixed)}
      style={{ "--click-in-w": `${width}px`, zIndex: 30 + depth } as CSSProperties}
      data-click-in-depth={depth}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
    >
      <header className={styles.header}>
        <Icon name={icon} size={16} className={styles.headerIcon} />
        <h3 className={styles.headerTitle}>{title}</h3>
        {canPopOut ? <IconButton size="sm" icon="picture-in-picture-2" label="Pop out" data-tip="Open this in its own window" onClick={() => void popOut()} /> : null}
        <IconButton size="sm" icon="x" label="Close" onClick={close} />
      </header>
      <div className={cx(styles.body, flush && styles.flush)}>{host ? <NestedHost parent={host}>{children}</NestedHost> : children}</div>
    </aside>
  ) : null;

  if (inline) {
    return (
      <>
        {headless ? null : launcher}
        {inlinePanel}
      </>
    );
  }
  return (
    <>
      {headless ? null : launcher}
      {drawer ? createPortal(drawer, hostEl ?? document.body) : null}
    </>
  );
}
