import { useMemo } from "react";
import { DepState } from "@/lib/api";
import { isMac } from "@/lib/platform";
import { Badge, Icon, IconButton, Tooltip, cx } from "@/components";
import { useDeps } from "@/state/deps";
import { useJobs, isActive } from "@/state/jobs";
import { useUI } from "@/state/ui";
import { RECENT_ITEM, SETTINGS_ITEM, useNavGroups, type NavItem } from "./nav";
import logoUrl from "@/assets/logo.svg";
import styles from "./Sidebar.module.css";

interface ItemProps {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
  dot?: "warn" | "danger" | null;
  running?: boolean;
  onClick: () => void;
}

function SidebarItem({ item, collapsed, active, dot, running, onClick }: ItemProps) {
  const btn = (
    <button
      type="button"
      className={cx(styles.item, active && styles.active, item.soon && styles.soon)}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      onClick={onClick}
    >
      <Icon name={item.icon} size={16} />
      {!collapsed && <span className={styles.label}>{item.label}</span>}
      {!collapsed && item.soon && <Badge>SOON</Badge>}
      {running && <span className={styles.running} title="Running" data-testid="running-indicator" />}
      {dot && <span className={cx(styles.dot, styles[dot])} data-testid={`dot-${dot}`} />}
    </button>
  );
  return collapsed ? (
    <Tooltip label={item.label} side="right" className={styles.tipWrap}>
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

export function Sidebar() {
  const view = useUI((s) => s.view);
  const collapsed = useUI((s) => s.sidebarCollapsed);
  const comingSoonOpen = useUI((s) => s.comingSoonOpen);
  const navigate = useUI((s) => s.navigate);
  const setCollapsed = useUI((s) => s.setSidebarCollapsed);
  const setSoonOpen = useUI((s) => s.setComingSoonOpen);
  const { tools, soon } = useNavGroups();
  const deps = useDeps((s) => s.list);
  const byId = useJobs((s) => s.byId);

  const runningModules = useMemo(() => {
    const set = new Set<string>();
    for (const j of Object.values(byId)) if (isActive(j)) set.add(j.moduleId);
    return set;
  }, [byId]);

  const settingsDot = useMemo<"warn" | "danger" | null>(() => {
    const required = deps.filter((d) => d.required);
    if (required.some((d) => d.state === DepState.DepError)) return "danger";
    if (required.some((d) => d.state === DepState.DepMissing)) return "warn";
    return null;
  }, [deps]);

  const item = (it: NavItem, dot?: "warn" | "danger" | null) => (
    <SidebarItem
      key={it.id}
      item={it}
      collapsed={collapsed}
      active={view === it.id}
      dot={dot}
      running={runningModules.has(it.id)}
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
          kbd="Mod+Backslash"
          tooltipSide="right"
          className={styles.noDrag}
          onClick={() => setCollapsed(!collapsed)}
        />
      </div>
      <div className={styles.scroll}>
        <Section label="Library" collapsed={collapsed}>
          {item(RECENT_ITEM)}
        </Section>
        <Section label="Tools" collapsed={collapsed}>
          {tools.map((t) => item(t))}
        </Section>
        {soon.length > 0 && (
          <Section
            label="Coming soon"
            collapsed={collapsed}
            toggle={{ open: comingSoonOpen, onToggle: () => setSoonOpen(!comingSoonOpen) }}
          >
            {(comingSoonOpen || collapsed) && soon.map((t) => item(t))}
          </Section>
        )}
      </div>
      <div className={styles.footer}>{item(SETTINGS_ITEM, settingsDot)}</div>
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
  toggle?: { open: boolean; onToggle: () => void };
  children: React.ReactNode;
}) {
  return (
    <div className={styles.section}>
      {!collapsed &&
        (toggle ? (
          <button type="button" className={cx(styles.sectionLabel, styles.sectionToggle)} onClick={toggle.onToggle} aria-expanded={toggle.open}>
            <Icon name={toggle.open ? "chevron-down" : "chevron-right"} size={12} />
            {label}
          </button>
        ) : (
          <div className={styles.sectionLabel}>{label}</div>
        ))}
      {children}
    </div>
  );
}
