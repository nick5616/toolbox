import { comboTokens } from "@/lib/platform";
import { cx } from "./cx";
import styles from "./Kbd.module.css";

export interface KbdProps {
  /** Platform-neutral combo such as "Mod+Shift+K". */
  combo: string;
  className?: string;
}

export function Kbd({ combo, className }: KbdProps) {
  const tokens = comboTokens(combo);
  return (
    <kbd className={cx(styles.kbd, className)} aria-label={tokens.join(" ")}>
      {tokens.map((token, i) => (
        <span key={i} className={styles.key} aria-hidden="true">
          {token}
        </span>
      ))}
    </kbd>
  );
}
