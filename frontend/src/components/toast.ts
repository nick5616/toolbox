import { create } from "zustand";

export type ToastTone = "neutral" | "success" | "warn" | "danger";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss delay in ms (default 5000). 0 keeps it until dismissed. */
  duration?: number;
}

export interface ToastItemData extends ToastOptions {
  id: string;
  /** True during the exit animation. */
  leaving: boolean;
}

export const DEFAULT_TOAST_DURATION = 5000;
export const MAX_VISIBLE_TOASTS = 4;
export const TOAST_EXIT_MS = 180;

interface ToastState {
  toasts: ToastItemData[];
}

export const useToastStore = create<ToastState>(() => ({ toasts: [] }));

let counter = 0;

/** Shows a toast and returns its id. */
export function toast(options: ToastOptions): string {
  const id = `toast-${++counter}`;
  useToastStore.setState((s) => ({ toasts: [...s.toasts, { ...options, id, leaving: false }] }));
  const live = useToastStore.getState().toasts.filter((t) => !t.leaving);
  for (const old of live.slice(0, Math.max(0, live.length - MAX_VISIBLE_TOASTS))) dismissToast(old.id);
  return id;
}

/** Starts the exit animation, then removes the toast. */
export function dismissToast(id: string): void {
  const current = useToastStore.getState().toasts.find((t) => t.id === id);
  if (!current || current.leaving) return;
  useToastStore.setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
  setTimeout(() => {
    useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }, TOAST_EXIT_MS);
}
