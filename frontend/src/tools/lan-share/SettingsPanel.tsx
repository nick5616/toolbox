import { useEffect, useState } from "react";
import { Button, Field, SegmentedControl, TextField, toast } from "@/components";
import { LanFromMode, LanShareService, LibraryService, type LanSettings } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isMac } from "@/lib/platform";
import { firewallHint } from "./model";
import styles from "./LanShareView.module.css";

const FROM_OPTIONS = [
  { value: LanFromMode.FromMine, label: "Only my devices", tip: "Only computers you paired can send" },
  { value: LanFromMode.FromAnyone, label: "Anyone nearby", tip: "Anyone on this network can ask to send; you are asked every time" },
] as const;

function report(e: unknown): void {
  toast({ tone: "danger", title: toAppError(e).message });
}

/** The Settings click-in: alias, who can send, PIN, the Received folder and the firewall hint. */
export function SettingsPanel({ pinSet }: { pinSet: boolean }) {
  const [settings, setSettings] = useState<LanSettings | null>(null);
  const [alias, setAlias] = useState("");
  const [pin, setPin] = useState("");

  useEffect(() => {
    let cancelled = false;
    LanShareService.Settings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setAlias(s.alias);
      })
      .catch(report);
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (patch: { alias?: string; from?: LanFromMode; pin?: string | null }) => {
    if (!settings) return;
    try {
      const next = await LanShareService.SetSettings({ alias: patch.alias ?? settings.alias, from: patch.from ?? settings.from, pin: patch.pin ?? null });
      setSettings(next);
      setAlias(next.alias);
    } catch (e) {
      report(e);
    }
  };

  const from = settings?.from ?? LanFromMode.FromAnyone;
  return (
    <div className={styles.settings}>
      <Field label="Name of this computer" hint="What other devices call it.">
        {(c) => (
          <TextField
            id={c.id}
            aria-describedby={c["aria-describedby"]}
            value={alias}
            placeholder={settings?.aliasAuto ?? ""}
            onChange={(e) => setAlias(e.target.value)}
            onBlur={() => alias !== (settings?.alias ?? "") && void save({ alias })}
            onKeyDown={(e) => e.key === "Enter" && void save({ alias })}
          />
        )}
      </Field>
      <Field label="Who can send" hint={from === LanFromMode.FromAnyone ? "Anyone nearby can ask; you say yes or no each time." : "Only computers you paired with Toolbox."}>
        <SegmentedControl aria-label="Who can send" value={from} options={FROM_OPTIONS} onChange={(v) => void save({ from: v })} />
      </Field>
      <Field label="PIN" hint={pinSet ? "Senders that aren't paired must type this PIN." : "Optional. A short code senders that aren't paired must type."}>
        {(c) => (
          <span className={styles.pinRow}>
            <TextField id={c.id} aria-describedby={c["aria-describedby"]} inputMode="numeric" value={pin} placeholder={pinSet ? "PIN is set" : "No PIN"} onChange={(e) => setPin(e.target.value.replace(/\s/g, ""))} />
            <Button
              size="sm"
              aria-disabled={pin === ""}
              data-tip={pin === "" ? "Type a PIN first" : "Require this PIN from senders that aren't paired"}
              onClick={() => {
                if (pin === "") return;
                void save({ pin }).then(() => setPin(""));
              }}
            >
              Set
            </Button>
            {pinSet && (
              <Button size="sm" variant="ghost" data-tip="Stop asking for a PIN" onClick={() => void save({ pin: "" })}>
                Clear
              </Button>
            )}
          </span>
        )}
      </Field>
      <Field label="Received folder" hint={settings?.receiveDir ?? ""}>
        {() => (
          <Button size="sm" variant="secondary" icon="folder-open" data-tip="Open the folder files you receive go to" onClick={() => void LibraryService.OpenLibraryFolder("Received").catch(report)}>
            Open
          </Button>
        )}
      </Field>
      <p className={styles.hint}>{settings?.firewallTip || firewallHint(isMac)}</p>
    </div>
  );
}
