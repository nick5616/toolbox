import { Button, EmptyState, toast } from "@/components";
import { toAppError } from "@/lib/errors";
import { closeWindow, focusWindow } from "@/lib/windows";
import { useModules } from "@/state/modules";
import styles from "./PoppedOutPlaceholder.module.css";

export interface PoppedOutPlaceholderProps {
  /** The tool window holding the tool (or its family): "tool:<id>". */
  windowKey: string;
}

/** Shown in the main window instead of a tool while it's open in its own window. */
export function PoppedOutPlaceholder({ windowKey }: PoppedOutPlaceholderProps) {
  const id = windowKey.replace(/^tool:/, "");
  const mod = useModules((s) => s.byId[id]);
  const name = mod?.name ?? id;
  const fail = (e: unknown) => toast({ tone: "danger", title: toAppError(e).message });
  return (
    <div className={styles.root}>
      <EmptyState
        icon={mod?.icon ?? "app-window"}
        title={`${name} is open in its own window`}
        body="It comes back here when you close that window or press Bring back."
        action={
          <div className={styles.actions}>
            <Button icon="app-window" onClick={() => focusWindow(windowKey).catch(fail)}>
              Show window
            </Button>
            <Button variant="ghost" onClick={() => closeWindow(windowKey).catch(fail)}>
              Bring back
            </Button>
          </div>
        }
      />
    </div>
  );
}
