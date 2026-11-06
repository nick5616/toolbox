import { IconButton, Switch } from "@/components";
import { AppIcon } from "@/blocks/app-picker";
import type { FocusAllowRule } from "@/lib/api";
import { baseName } from "./model";
import styles from "./RulesList.module.css";

export interface RulesListProps {
  rules: readonly FocusAllowRule[];
  /** Omit for a read-only list. */
  onChange?: (rules: FocusAllowRule[]) => void;
  empty?: string;
}

/** Dense allow-rule rows: icon, label, path, a Children switch, remove (SPEC §5.1). */
export function RulesList({ rules, onChange, empty = "Nothing here yet." }: RulesListProps) {
  if (rules.length === 0) return <p className={styles.empty}>{empty}</p>;
  const update = (i: number, patch: Partial<FocusAllowRule>) => onChange?.(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <ul className={styles.list}>
      {rules.map((r, i) => (
        <li key={`${r.id}|${r.kind}|${r.path}`} className={styles.row}>
          <AppIcon path={r.kind === "exe" ? r.path : ""} label={r.label} />
          <span className={styles.label} title={r.label}>
            {r.label}
          </span>
          <span className={styles.path} title={r.path} data-tip={r.kind === "folder" ? `Everything in ${r.path}` : r.path}>
            {r.kind === "folder" ? `${baseName(r.path)}\\*` : baseName(r.path)}
          </span>
          {onChange ? (
            <>
              <Switch
                checked={r.children}
                onChange={(v) => update(i, { children: v })}
                label="Children"
                tip="Programs this app starts are allowed too"
                aria-label={`Allow what ${r.label} starts`}
              />
              <IconButton size="sm" icon="x" label={`Remove ${r.label}`} onClick={() => onChange(rules.filter((_, j) => j !== i))} />
            </>
          ) : (
            <span className={styles.flag}>{r.children ? "with children" : "only itself"}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
