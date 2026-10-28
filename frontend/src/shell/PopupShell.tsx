import { Suspense } from "react";
import { EmptyState, Toaster } from "@/components";
import { popupViews } from "@/tools";
import styles from "./PopupShell.module.css";

export interface PopupShellProps {
  /** The `view` query parameter, e.g. "clipboard". */
  view: string;
}

/**
 * Root of a popup window (`/?window=popup&view=<id>`): just the requested
 * view, no sidebar or job tray. Each window has its own JS context.
 */
export function PopupShell({ view }: PopupShellProps) {
  const View = popupViews[view];
  return (
    <div className={styles.root}>
      {View ? (
        <Suspense fallback={null}>
          <View />
        </Suspense>
      ) : (
        <EmptyState icon="circle-alert" title="Nothing to show here" />
      )}
      <Toaster />
    </div>
  );
}
