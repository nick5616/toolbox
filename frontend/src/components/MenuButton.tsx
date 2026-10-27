// STUB (foundation). WP-K1 implements; props are frozen.
export interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuButtonProps {
  label: string;
  icon?: string;
  /** Items are computed lazily when the menu opens (may be async). */
  items: () => MenuItem[] | Promise<MenuItem[]>;
  /** Shown when items() resolves empty. */
  emptyLabel?: string;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary";
}

export function MenuButton({ label }: MenuButtonProps) {
  return <button type="button">{label}</button>;
}
