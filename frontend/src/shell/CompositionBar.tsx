/**
 * The composition strip in the top bar (Phase 10, SPEC.md §6): which tool a
 * variant is built on, the variants of this tool, and the parts it's made of.
 * Click opens the tool; Shift+click (or the small button on hover) pops it
 * out into its own window.
 */
import type { MouseEvent } from "react";
import { DesktopService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { NARROW_QUERY, useMediaQuery } from "@/lib/media";
import { currentWindow, popOutTool } from "@/lib/windows";
import { Icon, MenuButton, toast, type MenuItem } from "@/components";
import { openTool } from "@/lib/openTool";
import { compositionInputs, useBase, useParts, useVariants } from "@/state/composition";
import { useModule, type ModuleView } from "@/state/modules";
import { useUI } from "@/state/ui";
import { canOpenConstituent, openConstituent } from "./ConstituentDrawer";
import styles from "./CompositionBar.module.css";

export interface CompositionBarProps {
  /** The current view id (a module id, or library/settings/pipelines). */
  view: string;
  /**
   * One compact menu button instead of the chips: used while a tool header
   * shares the top bar (SPEC §13 rule 1), so the bar never crowds or wraps.
   */
  condensed?: boolean;
  /** Condensed and short on room: the menu is an icon (its label is the tooltip and aria-label). */
  iconOnly?: boolean;
}

type Relation = "base" | "variant" | "part";

function open(id: string): void {
  if (currentWindow().kind !== "main") {
    DesktopService.ShowMain(id).catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
    return;
  }
  useUI.getState().navigate(id);
}

function popOut(m: ModuleView): void {
  popOutTool(m.id, { title: `${m.name} — Toolbox` }).catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
}

function tipFor(rel: Relation, self: string, m: ModuleView): string {
  const hint = "Shift+click: open in its own window";
  if (rel === "base") return `${self} is built on ${m.name}. Open ${m.name}. ${hint}`;
  if (rel === "variant") return `${m.name} is built on ${self}. Open ${m.name}. ${hint}`;
  return `${self} uses ${m.name}. Open ${m.name}. ${hint}`;
}

/** A part's own window, loaded with the files the host reported for it. */
function popOutPart(host: string, m: ModuleView): void {
  void openTool(m.id, compositionInputs(host, m.id), {}, { window: true });
}

/** A part opens inside the current tool when it can, else it's navigated to. */
function openHere(host: string, m: ModuleView): void {
  if (canOpenConstituent(m.id)) openConstituent(host, m.id);
  else open(m.id);
}

function Chip({ m, rel, self, view, compact }: { m: ModuleView; rel: Relation; self: string; view: string; compact: boolean }) {
  const part = rel === "part";
  const tip = tipFor(rel, self, m);
  const click = (e: MouseEvent) => {
    if (part) {
      if (e.shiftKey) popOutPart(view, m);
      else openHere(view, m);
    } else if (e.shiftKey) popOut(m);
    else open(m.id);
  };
  return (
    <span className={styles.chipWrap} data-testid={`chip-${m.id}`}>
      <button
        type="button"
        className={styles.chip}
        aria-label={compact ? m.name : undefined}
        data-tip={compact ? `${m.name}. ${tip}` : tip}
        data-tip-side="bottom"
        onClick={click}
      >
        <Icon name={m.icon} size={13} />
        {!compact && <span className={styles.name}>{m.name}</span>}
      </button>
      {part ? (
        <span className={styles.popMenu}>
          <MenuButton
            size="sm"
            variant="ghost"
            icon="chevron-down"
            label={`Options for ${m.name}`}
            tip={`Open ${m.name} here, in its own window, or go to it`}
            items={() => [
              { id: "here", label: "Open here", icon: "panel-right", tip: `Open ${m.name} inside ${self}`, onSelect: () => openHere(view, m) },
              { id: "window", label: "Open in its own window", icon: "app-window", tip: `Open ${m.name} in its own window with the same files`, onSelect: () => popOutPart(view, m) },
              { id: "go", label: `Go to ${m.name}`, icon: m.icon, tip: `Switch to ${m.name}`, onSelect: () => open(m.id) },
            ]}
          />
        </span>
      ) : (
        <button
          type="button"
          className={styles.pop}
          aria-label={`Open ${m.name} in its own window`}
          data-tip={`Open ${m.name} in its own window`}
          data-tip-side="bottom"
          onClick={() => popOut(m)}
        >
          <Icon name="external-link" size={11} />
        </button>
      )}
    </span>
  );
}

function Group({ label, items, rel, self, view, compact }: { label: string; items: ModuleView[]; rel: Relation; self: string; view: string; compact: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.group} role="group" aria-label={label}>
      {!compact && <span className={styles.label}>{label}</span>}
      {items.map((m) => (
        <Chip key={m.id} m={m} rel={rel} self={self} view={view} compact={compact} />
      ))}
    </div>
  );
}

function CondensedMenu({ builtOn, variants, parts, self, view, iconOnly }: { builtOn: ModuleView[]; variants: ModuleView[]; parts: ModuleView[]; self: string; view: string; iconOnly: boolean }) {
  const label = builtOn.length + variants.length === 0 ? "Uses" : "Related";
  const items = (): MenuItem[] => [
    ...builtOn.map((m) => ({ id: `base:${m.id}`, label: `Built on ${m.name}`, icon: m.icon, tip: tipFor("base", self, m), onSelect: () => open(m.id) })),
    ...variants.map((m) => ({ id: `variant:${m.id}`, label: `Variant: ${m.name}`, icon: m.icon, tip: tipFor("variant", self, m), onSelect: () => open(m.id) })),
    ...parts.flatMap((m) => [
      { id: `part:${m.id}`, label: `Uses ${m.name}`, icon: m.icon, tip: tipFor("part", self, m), onSelect: () => openHere(view, m) },
      { id: `window:${m.id}`, label: `${m.name} in its own window`, icon: "app-window", tip: `Open ${m.name} in its own window with the same files`, onSelect: () => popOutPart(view, m) },
    ]),
  ];
  return (
    <div className={styles.bar} data-testid="composition-bar" data-condensed="true">
      <MenuButton size="sm" variant={iconOnly ? "ghost" : "secondary"} icon="layers" label={label} items={items} tip={`${label}: what ${self} is built on, its variants and the tools it uses`} />
    </div>
  );
}

export function CompositionBar({ view, condensed = false, iconOnly = false }: CompositionBarProps) {
  const self = useModule(view);
  const base = useBase(view);
  const variants = useVariants(view);
  const parts = useParts(view);
  const compact = useMediaQuery(NARROW_QUERY);
  if (!self) return null;
  const builtOn = base ? [base] : [];
  if (builtOn.length + variants.length + parts.length === 0) return null;
  if (condensed) return <CondensedMenu builtOn={builtOn} variants={variants} parts={parts} self={self.name} view={view} iconOnly={iconOnly} />;
  return (
    <div className={styles.bar} data-testid="composition-bar">
      <Group label="Built on" items={builtOn} rel="base" self={self.name} view={view} compact={compact} />
      <Group label="Variants" items={variants} rel="variant" self={self.name} view={view} compact={compact} />
      <Group label="Uses" items={parts} rel="part" self={self.name} view={view} compact={compact} />
    </div>
  );
}
