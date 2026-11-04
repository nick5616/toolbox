/**
 * The composition strip in the top bar (Phase 10, SPEC.md §6): which tool a
 * variant is built on, the variants of this tool, and the parts it's made of.
 * Click opens the tool; Shift+click (or the small button on hover) pops it
 * out into its own window.
 */
import { DesktopService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { NARROW_QUERY, useMediaQuery } from "@/lib/media";
import { currentWindow, popOutTool } from "@/lib/windows";
import { Icon, toast } from "@/components";
import { useBase, useParts, useVariants } from "@/state/composition";
import { useModule, type ModuleView } from "@/state/modules";
import { useUI } from "@/state/ui";
import styles from "./CompositionBar.module.css";

export interface CompositionBarProps {
  /** The current view id (a module id, or library/settings/pipelines). */
  view: string;
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

function Chip({ m, rel, self, compact }: { m: ModuleView; rel: Relation; self: string; compact: boolean }) {
  const tip = tipFor(rel, self, m);
  return (
    <span className={styles.chipWrap} data-testid={`chip-${m.id}`}>
      <button
        type="button"
        className={styles.chip}
        aria-label={compact ? m.name : undefined}
        data-tip={compact ? `${m.name}. ${tip}` : tip}
        data-tip-side="bottom"
        onClick={(e) => (e.shiftKey ? popOut(m) : open(m.id))}
      >
        <Icon name={m.icon} size={13} />
        {!compact && <span className={styles.name}>{m.name}</span>}
      </button>
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
    </span>
  );
}

function Group({ label, items, rel, self, compact }: { label: string; items: ModuleView[]; rel: Relation; self: string; compact: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.group} role="group" aria-label={label}>
      {!compact && <span className={styles.label}>{label}</span>}
      {items.map((m) => (
        <Chip key={m.id} m={m} rel={rel} self={self} compact={compact} />
      ))}
    </div>
  );
}

export function CompositionBar({ view }: CompositionBarProps) {
  const self = useModule(view);
  const base = useBase(view);
  const variants = useVariants(view);
  const parts = useParts(view);
  const compact = useMediaQuery(NARROW_QUERY);
  if (!self) return null;
  const builtOn = base ? [base] : [];
  if (builtOn.length + variants.length + parts.length === 0) return null;
  return (
    <div className={styles.bar} data-testid="composition-bar">
      <Group label="Built on" items={builtOn} rel="base" self={self.name} compact={compact} />
      <Group label="Variants" items={variants} rel="variant" self={self.name} compact={compact} />
      <Group label="Uses" items={parts} rel="part" self={self.name} compact={compact} />
    </div>
  );
}
