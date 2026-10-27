import { useEffect, useState } from "react";
import { bootstrap } from "@/state/bootstrap";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { Shell } from "@/shell/Shell";
import { BootError } from "@/views/BootError";

type BootState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; error: AppErrorShape };

export function App() {
  const [boot, setBoot] = useState<BootState>({ kind: "loading" });

  useEffect(() => {
    bootstrap().then(
      () => setBoot({ kind: "ready" }),
      (e: unknown) => setBoot({ kind: "error", error: toAppError(e) }),
    );
  }, []);

  if (boot.kind === "loading") return null;
  if (boot.kind === "error") return <BootError error={boot.error} onReload={() => window.location.reload()} />;
  return <Shell />;
}
