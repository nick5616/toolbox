/**
 * Workspace chrome (Phase 11, SPEC §3.3): the launcher of one panel, the
 * rail of launchers, a bar that never wraps, and the studio layout every
 * workspace tool uses. All of it follows the Phase 10 rules: one job per
 * screen, click-ins carry a summary, bars never wrap, rails never scroll.
 */
import { Children, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { ClickIn, ErrorBoundary, MenuButton, ToolHeader, useClickIn } from "@/components";
import { useElementSize } from "@/lib/useElementSize";
import { PartFrame } from "@/parts/PartFrame";
import type { Workspace } from "./types";
import styles from "./workspace.module.css";

/** The drawer id of a panel: how code opens it with `useClickIn().open(panelDrawerId(id))`. */
export const panelDrawerId = (panelId: string): string => `panel:${panelId}`;

export interface WorkspacePanelProps {
  ws: Workspace;
  panel: string;
  variant?: "row" | "icon";
  /** One line of the panel's current state ("3 layers", "Small · Auto-detect"). */
  summary?: string;
  /** Show the summary on the launcher (else only in the tooltip). Default true. */
  showSummary?: boolean;
  badge?: number;
  className?: string;
}

/** A click-in that opens one of the tool's panels in a drawer; Pop out opens it in its own window. */
export function WorkspacePanel({ ws, panel, variant = "row", summary, showSummary = true, badge, className }: WorkspacePanelProps) {
  const def = ws.getPanel(panel);
  if (!def) return null;
  const Body = def.component;
  const poppable = def.poppable !== false;
  return (
    <ClickIn
      id={panelDrawerId(panel)}
      icon={def.icon}
      title={def.title}
      summary={showSummary ? summary : undefined}
      tip={summary ? `${def.tip} (${summary})` : def.tip}
      part={poppable ? ws.panelPart : undefined}
      instance={panel}
      params={{ panel }}
      variant={variant}
      badge={badge}
      width={def.drawerWidth ?? 380}
      flush
      popOutSize={{ width: def.width ?? 380, height: def.height ?? 720 }}
      className={className}
    >
      <ErrorBoundary label={def.title} resetKey={panel} compact>
        <Body />
      </ErrorBoundary>
    </ClickIn>
  );
}

const ITEM_PX = 44;
const PAD_PX = 8;

/** How many of `count` items show in `height` px (all when unknown); one slot is the "More" item when some must go. */
export function railFit(count: number, height: number): number {
  if (height <= 0) return count;
  const slots = Math.max(1, Math.floor((height - PAD_PX) / ITEM_PX));
  return slots >= count ? count : Math.max(0, slots - 1);
}

export interface WorkspaceRailProps {
  ws: Workspace;
  /** Panel ids in order. */
  panels: readonly string[];
  /** Per panel: its summary (tooltip) and badge. */
  summaries?: Readonly<Record<string, string | undefined>>;
  badges?: Readonly<Record<string, number | undefined>>;
  /** Extra launchers after the panels (e.g. <ToolClickIn variant="icon">), each with a caption. */
  extra?: readonly { id: string; caption: string; node: ReactNode }[];
}

/** The left rail: one icon launcher per panel with its name under it. Never scrolls. */
export function WorkspaceRail({ ws, panels, summaries, badges, extra = [] }: WorkspaceRailProps) {
  const { open } = useClickIn();
  const [nav, setNav] = useState<HTMLElement | null>(null);
  const { height } = useElementSize(nav);
  const ids = panels.filter((id) => !!ws.getPanel(id));
  const items: { id: string; caption: string; node: (launcherOnly: boolean) => ReactNode; open?: () => void; icon?: string; tip?: string }[] = [
    ...ids.map((id) => ({
      id,
      caption: ws.getPanel(id)?.short ?? ws.getPanel(id)?.title ?? id,
      icon: ws.getPanel(id)?.icon,
      tip: ws.getPanel(id)?.tip,
      open: () => open(panelDrawerId(id)),
      node: () => <WorkspacePanel ws={ws} panel={id} variant="icon" summary={summaries?.[id]} showSummary={false} badge={badges?.[id]} />,
    })),
    ...extra.map((e) => ({ id: e.id, caption: e.caption, node: () => e.node })),
  ];
  const n = railFit(items.length, height);
  const rest = items.slice(n);
  return (
    <nav className={styles.rail} aria-label="Panels" ref={setNav}>
      {items.slice(0, n).map((it) => (
        <div key={it.id} className={styles.railItem}>
          {it.node(false)}
          <span className={styles.caption}>{it.caption}</span>
        </div>
      ))}
      {rest.length > 0 && (
        <>
          <div className={styles.railItem}>
            <MenuButton
              label="More panels"
              icon="ellipsis"
              variant="ghost"
              data-tip="The other panels of this tool"
              items={() => rest.filter((it) => it.open).map((it) => ({ id: it.id, label: it.caption, icon: it.icon, tip: it.tip, onSelect: () => it.open?.() }))}
            />
            <span className={styles.caption}>More</span>
          </div>
          {/* Their drawers stay mounted; the menu opens them. */}
          <span hidden>{rest.map((it) => <span key={it.id}>{it.node(true)}</span>)}</span>
        </>
      )}
    </nav>
  );
}

export interface OneLineBarProps {
  /** Items in priority order; each child needs a `key`. Approximate widths (px) decide what fits. */
  children: ReactNode;
  /** Width estimate per child key (default 120). */
  widths?: Readonly<Record<string, number>>;
  /** Menu entries for the children that don't fit, by key. */
  overflow?: (keys: string[]) => { id: string; label: string; icon?: string; tip?: string; onSelect: () => void }[];
  className?: string;
  "aria-label"?: string;
}

const MORE_PX = 40;

/** Which of `keys` fit in `width` (all when unknown), leaving room for a More button when some don't. */
export function fitBar(keys: readonly string[], widths: Readonly<Record<string, number>>, width: number): number {
  if (width <= 0) return keys.length;
  const w = (k: string) => (widths[k] ?? 120) + 4;
  const total = keys.reduce((n, k) => n + w(k), 0);
  if (total <= width) return keys.length;
  let used = 0;
  let shown = 0;
  for (const k of keys) {
    if (used + w(k) + MORE_PX > width) break;
    used += w(k);
    shown++;
  }
  return shown;
}

/** A toolbar or selection bar that never wraps: what doesn't fit goes into a "More" menu. */
export function OneLineBar({ children, widths = {}, overflow, className, "aria-label": label }: OneLineBarProps) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { width } = useElementSize(el);
  const kids = Children.toArray(children).filter(isValidElement) as ReactElement[];
  const keys = kids.map((k, i) => String(k.key ?? i).replace(/^\.\$/, ""));
  const n = fitBar(keys, widths, width);
  const hidden = keys.slice(n);
  return (
    <div ref={setEl} className={[styles.bar, className].filter(Boolean).join(" ")} role="toolbar" aria-label={label}>
      {kids.slice(0, n).map((k, i) => (
        <span key={keys[i]} className={styles.barItem}>
          {k}
        </span>
      ))}
      {hidden.length > 0 && overflow && <MenuButton label="More" icon="ellipsis" variant="ghost" data-tip="More actions" items={() => overflow(hidden)} />}
    </div>
  );
}

export interface StudioLayoutProps {
  /**
   * Header, left to right: back/title/state … then `headerEnd` (undo, More, the
   * primary action). One line. It renders in the shell's top bar (SPEC §13 rule 1),
   * inline above the layout only when embedded or without a shell slot.
   */
  header: ReactNode;
  rail?: ReactNode;
  /** The preview/canvas: gets the room. */
  stage: ReactNode;
  /** Optional right column (the main editing list: cues, lyric lines). */
  side?: ReactNode;
  /** Width of `side` in px (default 360). */
  sideWidth?: number;
  /** Optional bottom area (a one-line bar, a timeline). */
  bottom?: ReactNode;
  className?: string;
}

/** header / rail | stage | side / bottom: the layout of every workspace tool. Wrap it in a <ClickInHost>. */
export function StudioLayout({ header, rail, stage, side, sideWidth = 360, bottom, className }: StudioLayoutProps) {
  return (
    <div className={[styles.studio, className].filter(Boolean).join(" ")}>
      <ToolHeader className={styles.studioHeader}>{header}</ToolHeader>
      {rail ? <div className={styles.studioRail}>{rail}</div> : null}
      <section className={styles.studioStage} aria-label="Preview">
        {stage}
      </section>
      {side ? (
        <aside className={styles.studioSide} style={{ width: sideWidth }}>
          {side}
        </aside>
      ) : null}
      {bottom ? <div className={styles.studioBottom}>{bottom}</div> : null}
    </div>
  );
}

/** The header's flexible gap. */
export function Spacer() {
  return <span className={styles.spacer} />;
}

/** The tool's preview, poppable when the workspace has a preview part. */
export function WorkspacePreviewFrame({ ws, children }: { ws: Workspace; children: ReactNode }) {
  if (!ws.previewPart) return <>{children}</>;
  return (
    <PartFrame part={ws.previewPart} chrome="overlay" keepWhileOut={!!ws.previewMirror}>
      {children}
    </PartFrame>
  );
}
