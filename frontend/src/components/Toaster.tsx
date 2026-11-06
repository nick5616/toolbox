import { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { cx } from "./cx";
import { DEFAULT_TOAST_DURATION, dismissToast, useToastStore, type ToastItemData, type ToastTone } from "./toast";
import styles from "./Toaster.module.css";

const iconFor: Record<ToastTone, string> = {
  neutral: "info",
  success: "check",
  warn: "triangle-alert",
  danger: "circle-alert",
};

function ToastItem({ data }: { data: ToastItemData }) {
  const { id, title, description, action, secondaryAction, leaving } = data;
  const tone = data.tone ?? "neutral";
  const duration = data.duration ?? DEFAULT_TOAST_DURATION;

  const remaining = useRef(duration);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const start = () => {
    if (duration <= 0 || leaving) return;
    clearTimeout(timer.current);
    startedAt.current = Date.now();
    timer.current = setTimeout(() => dismissToast(id), remaining.current);
  };
  const pause = () => {
    if (duration <= 0 || !timer.current) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    remaining.current = Math.max(500, remaining.current - (Date.now() - startedAt.current));
  };

  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role={tone === "danger" || tone === "warn" ? "alert" : "status"}
      className={cx(styles.toast, styles[tone], leaving && styles.leaving)}
      onMouseEnter={pause}
      onMouseLeave={start}
      onFocus={pause}
      onBlur={start}
    >
      <Icon name={iconFor[tone]} size={16} className={styles.icon} />
      <div className={styles.content}>
        <div className={styles.title}>{title}</div>
        {description && <div className={styles.description}>{description}</div>}
        {(action || secondaryAction) && (
          <div className={styles.actions}>
            {[action, secondaryAction].map((a) =>
              a ? (
                <button
                  key={a.label}
                  type="button"
                  className={styles.action}
                  data-tip={`${a.label} (this also closes the notification)`}
                  onClick={() => {
                    a.onClick();
                    dismissToast(id);
                  }}
                >
                  {a.label}
                </button>
              ) : null,
            )}
          </div>
        )}
      </div>
      <IconButton size="sm" icon="x" label="Dismiss" data-tip="Close this notification" onClick={() => dismissToast(id)} />
    </div>
  );
}

/** Mount once near the app root. Position: bottom-right, above `--toaster-bottom` (default 52px). */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className={styles.region} role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastItem key={t.id} data={t} />
      ))}
    </div>
  );
}
