import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LogStream } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { Button, toast, cx } from "@/components";
import { useJobs } from "@/state/jobs";
import styles from "./LogPanel.module.css";

const VISIBLE_LINES = 1000;

export function LogPanel({ jobId }: { jobId: string }) {
  const lines = useJobs((s) => s.logs[jobId]);
  const [showAll, setShowAll] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    useJobs
      .getState()
      .loadLogs(jobId)
      .catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
  }, [jobId]);

  const total = lines?.length ?? 0;
  const hidden = showAll ? 0 : Math.max(0, total - VISIBLE_LINES);
  const visible = lines ? (hidden ? lines.slice(hidden) : lines) : [];

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [total]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    stick.current = bottom;
    setAtBottom(bottom);
  }, []);

  const jump = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const copy = () => {
    const text = (lines ?? []).map((l) => l.text).join("\n");
    navigator.clipboard.writeText(text).then(
      () => toast({ tone: "success", title: "Log copied" }),
      (e: unknown) => toast({ tone: "danger", title: toAppError(e).message }),
    );
  };

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <Button size="sm" variant="ghost" icon="copy" onClick={copy}>
          Copy
        </Button>
      </div>
      <div ref={ref} className={styles.scroll} onScroll={onScroll} role="log" aria-label="Job log">
        {hidden > 0 && (
          <button type="button" className={styles.showAll} onClick={() => setShowAll(true)}>
            Show all {total} lines
          </button>
        )}
        {visible.length === 0 && <div className={styles.empty}>No log output.</div>}
        {visible.map((l) => (
          <div
            key={l.seq}
            className={cx(styles.line, l.stream === LogStream.StreamStderr && styles.stderr, l.stream === LogStream.StreamSystem && styles.system)}
          >
            {l.text}
          </div>
        ))}
      </div>
      {!atBottom && (
        <button type="button" className={styles.jump} onClick={jump}>
          Jump to latest
        </button>
      )}
    </div>
  );
}
