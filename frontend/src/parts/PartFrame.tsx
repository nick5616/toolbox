import type { ReactNode } from "react";
import { Button, Icon, IconButton, cx, toast } from "@/components";
import { toAppError } from "@/lib/errors";
import { closeWindow, focusWindow, partWindowKey, popOutPart } from "@/lib/windows";
import { useUI } from "@/state/ui";
import { useWindowOpen } from "@/state/windows";
import { getPart } from "./registry";
import styles from "./PartFrame.module.css";

export interface PartFrameProps {
  /** A registered part id ("edit-studio.preview"). */
  part: string;
  instance?: string;
  /** Extra URL params for the part's window. */
  params?: Record<string, string>;
  /** "overlay": a pop-out button at the top right on hover/focus. "header": a 28 px header with the title. */
  chrome?: "overlay" | "header";
  children: ReactNode;
  className?: string;
}

/** Wraps a part rendered inline: adds the pop-out button and, while the part's window is open, a placeholder. */
export function PartFrame({ part, instance, params, chrome = "overlay", children, className }: PartFrameProps) {
  const spec = getPart(part);
  const key = partWindowKey(part, instance);
  const out = useWindowOpen(key);
  const view = useUI((s) => s.view);
  const title = spec?.title ?? part;

  const fail = (e: unknown) => toast({ tone: "danger", title: toAppError(e).message });
  const popOut = () => {
    popOutPart(part, {
      title: `${title} — Toolbox`,
      width: spec?.width,
      height: spec?.height,
      instance,
      params: { ...(params ?? {}), view },
    }).catch(fail);
  };

  if (out) {
    return (
      <div className={cx(styles.placeholder, className)} role="status">
        <Icon name={spec?.icon ?? "app-window"} size={16} className={styles.placeholderIcon} />
        <span className={styles.placeholderText}>{title}: open in its own window</span>
        <Button size="sm" onClick={() => focusWindow(key).catch(fail)}>
          Show
        </Button>
        <Button size="sm" variant="ghost" onClick={() => closeWindow(key).catch(fail)}>
          Bring back
        </Button>
      </div>
    );
  }

  const button = (
    <IconButton
      size="sm"
      icon="picture-in-picture-2"
      label="Pop out"
      data-tip={spec?.tip ? `Pop out: ${spec.tip}` : `Open ${title} in its own window`}
      onClick={popOut}
    />
  );

  return (
    <div className={cx(styles.frame, className)} data-part={part}>
      {chrome === "header" ? (
        <header className={styles.header}>
          {spec ? <Icon name={spec.icon} size={14} className={styles.headerIcon} /> : null}
          <span className={styles.headerTitle}>{title}</span>
          {button}
        </header>
      ) : (
        <div className={styles.overlay}>{button}</div>
      )}
      <div className={styles.content}>{children}</div>
    </div>
  );
}
