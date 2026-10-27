import { Button, Icon } from "@/components";
import type { AppErrorShape } from "@/lib/errors";
import styles from "./BootError.module.css";

export interface BootErrorProps {
  error: AppErrorShape;
  onReload: () => void;
}

export function BootError({ error, onReload }: BootErrorProps) {
  return (
    <div className={styles.root}>
      <section className={styles.panel} role="alert">
        <span className={styles.icon}>
          <Icon name="triangle-alert" size={32} />
        </span>
        <h1 className={styles.title}>Toolbox couldn't start</h1>
        <p className={styles.message}>{error.message}</p>
        {error.hint ? <p className={styles.hint}>{error.hint}</p> : null}
        {error.code ? <code className={styles.code}>{error.code}</code> : null}
        <Button variant="primary" onClick={onReload}>
          Reload
        </Button>
      </section>
    </div>
  );
}
