// STUB (foundation). WP-H replaces this file.
import type { AppErrorShape } from "@/lib/errors";

export interface BootErrorProps {
  error: AppErrorShape;
  onReload: () => void;
}

export function BootError({ error, onReload }: BootErrorProps) {
  return (
    <section role="alert">
      <p>{error.message}</p>
      <button onClick={onReload}>Reload</button>
    </section>
  );
}
