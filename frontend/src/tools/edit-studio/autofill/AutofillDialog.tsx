/** The Auto-fill dialog (§13.4). Wave 0 stub (owned by WP-ES6); the props are frozen. */
export interface AutofillDialogProps {
  open: boolean;
  /** A preselected range (timeline ms), or null for the whole edit. */
  range: { fromMs: number; toMs: number } | null;
  onClose(): void;
}

export function AutofillDialog(props: AutofillDialogProps) {
  void props;
  return null;
}
