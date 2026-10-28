import { Icon } from "@/components";

/** The shared Icon (kept as a name so the setup screens read the same). */
export function PackIcon({ name, size = 16, strokeWidth }: { name: string; size?: number; strokeWidth?: number }) {
  return <Icon name={name} size={size} strokeWidth={strokeWidth} />;
}
