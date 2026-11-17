import { memo, useEffect, useMemo, useState } from "react";
import { DepState } from "@/lib/api";
import { isMac } from "@/lib/platform";
import { Badge, Icon, IconButton, cx } from "@/components";
import { startToolDrag } from "@/lib/fileDrag";
import { useDeps } from "@/state/deps";
import { useJobs, isActive } from "@/state/jobs";
import { useSidebarCollapsed, useUI } from "@/state/ui";
import { useLanShare } from "@/state/lanshare";
// --- pipelines ---
import { isRunActive, useNeedsYou, usePipelines } from "@/state/pipelines";
// --- end pipelines ---
import { PIPELINES_ITEM, RECENT_ITEM, SETTINGS_ITEM, useNavGroups, type NavItem } from "./nav";
import logoUrl from "@/assets/logo.svg";
import { FOCUS_MODULE_ID, isActive as focusIsActive, useFocus } from "@/state/focus";
import styles from "./Sidebar.module.css";

interface ItemProps {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
  dot?: "warn" | "danger" | null;
  running?: boolean;
  /** Local File Transfer is listening. */
  receiving?: boolean;
  /** A focus session is on (Phase 18). */
  focusing?: boolean;
  /** Pipelines: number of steps waiting for the user. */
  badge?: number;
  /** Mod+digit that opens this tool. */
  digit?: number;
  /** Tools can be pinned (hover pin + context menu) and dropped on. */
  tool?: { pinned: boolean; onTogglePin: () => void; onContextMenu: (x: number, y: number) => void };
  onClick: () => void;
}

/**
 * Re-render only when something visible changed. The callbacks (`onClick`, `tool.*`) are
 * rebuilt every render but only close over stable store actions and `item.id`.
 */
function itemPropsEqual(a: ItemProps, b: ItemProps): boolean {
  return (
    a.item.id === b.item.id &&
    a.item.label === b.item.label &&
    a.item.icon === b.item.icon &&
    a.item.soon === b.item.soon &&
    a.item.variantOf === b.item.variantOf &&
    a.item.tip === b.item.tip &&
    a.collapsed === b.collapsed &&
    a.active === b.active &&
    a.dot === b.dot &&
    a.running === b.running &&
    a.receiving === b.receiving &&
    a.focusing === b.focusing &&
    a.badge === b.badge &&
    a.digit === b.digit &&
    !a.tool === !b.tool &&
    a.tool?.pinned === b.tool?.pinned
  );
}

const SidebarItem = memo(function SidebarItem({ item, collapsed, active, dot, running, receiving, badge, digit, tool, focusing, onClick }: ItemProps) {
  const tipText = item.tip ? `${item.label}: ${item.tip}` : item.label;
  const btn = (
    <button
      type="button"
      className={cx(styles.item, active && styles.active, item.soon && styles.soon, item.variantOf && styles.variant)}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      data-tip={collapsed ? tipText : item.tip}
      data-tip-kbd={digit ? `Mod+${digit}` : undefined}
      data-tip-side="right"
      onClick={onClick}
    >
      <Icon name={item.icon} size={item.variantOf && !collapsed ? 14 : 16} />
      {collapsed && item.variantOf && <span className={styles.variantBadge} aria-hidden="true" data-testid="variant-badge" />}
      {!collapsed && <span className={styles.label}>{item.label}</span>}
      {!collapsed && item.soon && <Badge tip="Not available yet">SOON</Badge>}
      {!collapsed && badge ? (
        <span className={styles.badge} aria-label={`${badge} waiting for you`} data-tip="Pipeline steps waiting for you to do something">
          {badge}
        </span>
      ) : null}
      {running && <span className={styles.running} data-tip="A job from this tool is running" data-testid="running-indicator" />}
      {focusing && <span className={styles.running} data-tip="A focus session is on" data-testid="focus-indicator" />}
      {receiving && <span className={styles.receiving} data-tip="Receiving files from other devices" data-testid="receiving-indicator" />}
      {dot && <span className={cx(styles.dot, styles[dot])} data-testid={`dot-${dot}`} data-tip={dot === "danger" ? "A required component failed to install: open Settings" : "A required component is missing: open Settings to install it"} />}
    </button>
  );
  if (!tool) return btn;
  return (
    <div
      className={styles.row}
      id={`tool-drop:${item.id}`}
      data-file-drop-target
      data-testid={`nav-${item.id}`}
      draggable={!item.soon}
      onDragStart={(e) => startToolDrag(e, item.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        tool.onContextMenu(e.clientX, e.clientY);
      }}
    >
      {btn}
      {!collapsed && !item.soon && (
        <button
          type="button"
          className={cx(styles.pin, tool.pinned && styles.pinned)}
          aria-label={tool.pinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
          aria-pressed={tool.pinned}
          data-tip={tool.pinned ? "Remove from Pinned" : "Pin to the top of the sidebar"}
          data-tip-side="right"
          onClick={tool.onTogglePin}
        >
          <Icon name="pin" size={12} />
        </button>
      )}
    </div>
  );
}, itemPropsEqual);

export function Sidebar() {
  const view = useUI((s) => s.view);
  const collapsed = useSidebarCollapsed();
  const comingSoonOpen = useUI((s) => s.comingSoonOpen);
  const navigate = useUI((s) => s.navigate);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const setSoonOpen = useUI((s) => s.setComingSoonOpen);
  const { soon, groups, pinned, recent, digits } = useNavGroups();
  const pinnedIds = useUI((s) => s.pinned);
  const collapsedGroups = useUI((s) => s.collapsedGroups);
  const togglePin = useUI((s) => s.togglePin);
  const toggleGroup = useUI((s) => s.toggleGroup);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const deps = useDeps((s) => s.list);
  const lanListening = useLanShare((s) => s.state.listening);

  // A stable string key: progress ticks don't change it, so the sidebar doesn't re-render for them.
  const runningKey = useJobs((s) => {
    const ids = new Set<string>();
    for (const j of Object.values(s.byId)) if (isActive(j)) ids.add(j.moduleId);
    return Array.from(ids).sort().join("\n");
  });
  const runningModules = useMemo(() => new Set(runningKey ? runningKey.split("\n") : []), [runningKey]);

  const settingsDot = useMemo<"warn" | "danger" | null>(() => {
    const required = deps.filter((d) => d.required);
    if (required.some((d) => d.state === DepState.DepError)) return "danger";
    if (required.some((d) => d.state === DepState.DepMissing)) return "warn";
    return null;
  }, [deps]);

  // --- pipelines ---
  const focusOn = useFocus((s) => focusIsActive(s.state));
  const needsYou = useNeedsYou().length;
  const pipelinesRunning = usePipelines((st) => Object.values(st.runs).some(isRunActive));
  // --- end pipelines ---

  const item = (it: NavItem, dot?: "warn" | "danger" | null, extra?: { badge?: number; running?: boolean; tool?: boolean; keyPrefix?: string }) => (
    <SidebarItem
      key={`${extra?.keyPrefix ?? ""}${it.id}`}
      item={it}
      digit={digits[it.id]}
      tool={
        extra?.tool
          ? {
              pinned: pinnedIds.includes(it.id),
              onTogglePin: () => togglePin(it.id),
              onContextMenu: (x, y) => setMenu({ id: it.id, x, y }),
            }
          : undefined
      }
      collapsed={collapsed}
      active={view === it.id}
      dot={dot}
      running={extra?.running ?? runningModules.has(it.id)}
      receiving={it.id === "lan-share" && lanListening}
      focusing={it.id === FOCUS_MODULE_ID && focusOn}
      badge={extra?.badge}
      onClick={() => navigate(it.id)}
    />
  );

  return (
    <nav className={cx(styles.sidebar, collapsed && styles.collapsed)} aria-label="Sidebar">
      <div className={cx(styles.header, isMac && styles.mac)}>
        {!collapsed && (
          <span className={styles.brand}>
            <span className={styles.logo} style={{ maskImage: `url("${logoUrl}")`, WebkitMaskImage: `url("${logoUrl}")` }} aria-hidden="true" />
            Toolbox
          </span>
        )}
        <IconButton
          size="sm"
          icon="panel-left"
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-tip={collapsed ? "Show tool names next to the icons" : "Shrink the sidebar to icons only"}
          kbd="Mod+Backslash"
          tooltipSide="right"
          className={styles.noDrag}
          onClick={toggleSidebar}
        />
      </div>
      <div className={styles.scroll}>
        <Section label="" collapsed={collapsed}>
          {item(RECENT_ITEM)}
        </Section>
        {/* --- pipelines item (UI2 adds the "needs you" badge) --- */}
        <Section label="Automation" collapsed={collapsed}>
          {item(PIPELINES_ITEM, null, { badge: needsYou, running: pipelinesRunning })}
        </Section>
        {/* --- end pipelines item --- */}
        {pinned.length > 0 && (
          <Section label="Pinned" collapsed={collapsed}>
            {pinned.map((t) => item({ ...t, variantOf: undefined }, null, { tool: true, keyPrefix: "pin:" }))}
          </Section>
        )}
        {recent.length > 0 && (
          <Section label="Recent tools" collapsed={collapsed}>
            {recent.map((t) => item({ ...t, variantOf: undefined }, null, { tool: true, keyPrefix: "recent:" }))}
          </Section>
        )}
        {groups.map((g) => {
          const open = !collapsedGroups.includes(g.id);
          return (
            <Section key={g.id} label={g.label} collapsed={collapsed} toggle={{ open, onToggle: () => toggleGroup(g.id), tip: open ? `Hide the ${g.label} tools` : `Show the ${g.label} tools` }}>
              {(open || collapsed) && g.items.map((t) => item(t, null, { tool: true }))}
            </Section>
          );
        })}
        {soon.length > 0 && (
          <Section
            label="Coming soon"
            collapsed={collapsed}
            toggle={{ open: comingSoonOpen, onToggle: () => setSoonOpen(!comingSoonOpen), tip: comingSoonOpen ? "Hide tools that are not ready yet" : "Show tools that are not ready yet" }}
          >
            {(comingSoonOpen || collapsed) && soon.map((t) => item(t))}
          </Section>
        )}
      </div>
      <div className={styles.footer}>{item(SETTINGS_ITEM, settingsDot)}</div>
      {menu && (
        <div className={styles.menu} role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              togglePin(menu.id);
              setMenu(null);
            }}
          >
            <Icon name="pin" size={14} />
            {pinnedIds.includes(menu.id) ? "Unpin from sidebar" : "Pin to sidebar"}
          </button>
        </div>
      )}
    </nav>
  );
}

function Section({
  label,
  collapsed,
  toggle,
  children,
}: {
  label: string;
  collapsed: boolean;
  toggle?: { open: boolean; onToggle: () => void; tip: string };
  children: React.ReactNode;
}) {
  return (
    <div className={styles.section}>
      {collapsed ? (
        <hr className={styles.sep} />
      ) : toggle ? (
        <button type="button" className={cx(styles.sectionLabel, styles.sectionToggle)} onClick={toggle.onToggle} aria-expanded={toggle.open} data-tip={toggle.tip}>
          <Icon name={toggle.open ? "chevron-down" : "chevron-right"} size={12} />
          {label}
        </button>
      ) : label ? (
        <div className={styles.sectionLabel}>{label}</div>
      ) : null}
      {children}
    </div>
  );
}
