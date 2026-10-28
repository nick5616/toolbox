import { ChevronLeft, HardDrive, ScanText, ShieldCheck, type LucideIcon } from "lucide-react";
import { Icon } from "@/components";

/** Icons the setup and packs screens need that the shared Icon map doesn't have yet. */
const extra: Record<string, LucideIcon> = {
  "scan-text": ScanText,
  "shield-check": ShieldCheck,
  "hard-drive": HardDrive,
  "chevron-left": ChevronLeft,
};

export function PackIcon({ name, size = 16, strokeWidth }: { name: string; size?: number; strokeWidth?: number }) {
  const Cmp = Object.hasOwn(extra, name) ? extra[name] : undefined;
  if (Cmp) return <Cmp size={size} strokeWidth={strokeWidth ?? 1.75} aria-hidden="true" focusable="false" />;
  return <Icon name={name} size={size} strokeWidth={strokeWidth} />;
}
