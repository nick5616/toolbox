// STUB (foundation). WP-K1 implements; props are frozen.
import type { ReactNode } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  /** "danger" styles the confirm button as destructive. */
  tone?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title }: ConfirmDialogProps) {
  return open ? <div role="dialog" aria-label={title} /> : null;
}
