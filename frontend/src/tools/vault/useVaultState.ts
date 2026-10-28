import { useEffect, useState } from "react";
import { VaultService, type VaultState } from "@/lib/api";
import { on } from "@/lib/events";

/** Live vault state: loaded once, then pushed by the `vault:state` event. */
export function useVaultState(): VaultState | null {
  const [state, setState] = useState<VaultState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const off = on("vault:state", (s) => {
      if (!cancelled) setState(s);
    });
    Promise.resolve()
      .then(() => VaultService.State())
      .then((s) => !cancelled && setState((cur) => cur ?? s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return state;
}

/** "9 min" / "45 s" until `lockAt` (Unix ms), or null when there is no timer. */
export function formatLockIn(lockAt: number, now: number): string | null {
  if (lockAt <= 0) return null;
  const ms = Math.max(0, lockAt - now);
  if (ms < 60_000) return `${Math.max(1, Math.ceil(ms / 1000))} s`;
  return `${Math.ceil(ms / 60_000)} min`;
}

/** Re-renders every second while a lock timer is set; returns the current time. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export type Strength = { level: 0 | 1 | 2 | 3; label: string };

/** Simple strength hint from length and character classes. */
export function passphraseStrength(p: string): Strength {
  if (p.length < 8) return { level: 0, label: "Too short (at least 8 characters)" };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  const score = (p.length >= 12 ? 2 : p.length >= 10 ? 1 : 0) + (classes >= 3 ? 2 : classes === 2 ? 1 : 0);
  if (score >= 4) return { level: 3, label: "Strong" };
  if (score >= 2) return { level: 2, label: "Okay" };
  return { level: 1, label: "Weak: try a longer phrase" };
}
