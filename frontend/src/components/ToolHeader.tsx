/**
 * A tool's header row (document name, save state, undo/redo, More, the
 * primary action). Polish pass (SPEC §13 rule 1): one header row per screen,
 * so the shell renders this inside its own top bar (and a tool window inside
 * its title bar) through a slot; embedded tools and anything without a slot
 * render it inline.
 */
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIsEmbedded } from "@/lib/embed";
import { openLibrary } from "@/lib/openLibrary";
import { currentWindow } from "@/lib/windows";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { cx } from "./cx";
import { IconButton } from "./IconButton";
import styles from "./ToolHeader.module.css";

const HeaderSlotContext = createContext<HTMLElement | null>(null);

/** The shell / tool window provides the element tool headers portal into. */
export const HeaderSlotProvider = HeaderSlotContext.Provider;

/**
 * Optional: the shell learns whether a tool header is currently portaled into
 * its slot (so it can condense the composition chips). Called with true on
 * mount and false on unmount.
 */
export const HeaderPresenceContext = createContext<((present: boolean) => void) | null>(null);

export interface ToolHeaderProps {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/**
 * The standard "Show in Library" control every tool header ends with (Phase 19):
 * the Library filtered to this tool's results with the newest selected. Only in
 * the main window (a tool window has no Library), never inside another tool.
 */
function ShowInLibrary({ embedded }: { embedded: boolean }) {
  const view = useUI((s) => s.view);
  const known = useModules((s) => !!s.byId[view]);
  if (embedded || !known || currentWindow().kind !== "main") return null;
  return <IconButton size="sm" icon="history" label="Show in Library" data-tip="Show this tool's results in the Library" onClick={() => openLibrary({ moduleId: view })} />;
}

export function ToolHeader({ children, className, "aria-label": label = "Tool" }: ToolHeaderProps) {
  const slot = useContext(HeaderSlotContext);
  const embedded = useIsEmbedded();
  const report = useContext(HeaderPresenceContext);
  const portaled = !!slot && !embedded;
  useEffect(() => {
    if (!portaled || !report) return;
    report(true);
    return () => report(false);
  }, [portaled, report]);
  if (!slot || embedded) {
    return (
      <div className={cx(styles.inline, className)} role="toolbar" aria-label={label}>
        {children}
        <ShowInLibrary embedded={embedded} />
      </div>
    );
  }
  return createPortal(
    <div className={cx(styles.inTopbar, className)} role="toolbar" aria-label={label}>
      {children}
      <ShowInLibrary embedded={embedded} />
    </div>,
    slot,
  );
}
