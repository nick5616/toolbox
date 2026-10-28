import { useCallback, useEffect, useState } from "react";
import { Button, Switch } from "@/components";
import { DesktopService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isMac } from "@/lib/platform";
import styles from "./ClipboardSettingsPanel.module.css";

export type PastePermission = "granted" | "denied" | "unsupported" | "unknown";

function normalize(v: string): PastePermission {
  return v === "granted" || v === "denied" || v === "unsupported" ? v : "unknown";
}

/** Current auto-paste permission, refreshed when the window regains focus. */
export function usePastePermission(): [PastePermission, () => Promise<void>] {
  const [perm, setPerm] = useState<PastePermission>("unknown");
  const refresh = useCallback(async () => {
    try {
      setPerm(normalize(await DesktopService.PastePermission()));
    } catch {
      setPerm("unknown");
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  return [perm, refresh];
}

export interface AutoPasteSettingProps {
  checked: boolean;
  onChange: (checked: boolean) => void | Promise<void>;
}

/** Opt-in "paste into the previous app" switch with the OS permission status. */
export function AutoPasteSetting({ checked, onChange }: AutoPasteSettingProps) {
  const [perm, refresh] = usePastePermission();
  const [error, setError] = useState("");
  const unsupported = perm === "unsupported";

  const request = async () => {
    setError("");
    try {
      await DesktopService.RequestPastePermission();
    } catch (e) {
      setError(toAppError(e).message);
    }
    await refresh();
  };

  const toggle = async (next: boolean) => {
    await onChange(next);
    if (next && perm === "denied") await request();
  };

  return (
    <div className={styles.autoPaste}>
      <Switch
        checked={checked && !unsupported}
        disabled={unsupported}
        onChange={(v) => void toggle(v)}
        label="Paste into the previous app after picking an item"
        aria-describedby="clip-autopaste-status"
      />
      <div id="clip-autopaste-status" className={styles.pasteStatus}>
        {unsupported ? (
          <p className={styles.note}>Not supported on this platform yet</p>
        ) : checked && perm === "denied" ? (
          <p className={styles.note} role="status">
            Needs Accessibility permission
            <Button size="sm" variant="secondary" onClick={() => void request()}>
              Request permission
            </Button>
          </p>
        ) : checked && perm === "granted" ? (
          <p className={styles.note} role="status">
            Allowed
          </p>
        ) : null}
        {isMac && !unsupported && checked && (
          <p className={styles.note}>Dev builds may need re-allowing after a rebuild.</p>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
