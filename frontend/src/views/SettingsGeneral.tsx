import { useState } from "react";
import { Badge, Button, HotkeyRecorder, Section, Switch, Tooltip } from "@/components";
import type { HotkeyStatus, SettingsPatch } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useDesktop } from "@/state/desktop";
import { DEFAULT_HOTKEYS, useSettings } from "@/state/settings";
import styles from "./SettingsGeneral.module.css";

const HOTKEY_ROWS: Array<{ action: string; label: string }> = [
  { action: "clipboard", label: "Open clipboard history" },
  { action: "quickOpen", label: "Quick open (command palette)" },
];

function StatusBadge({ accelerator, status }: { accelerator: string; status: HotkeyStatus | undefined }) {
  if (!accelerator) return <Badge tip="No shortcut is set for this action">Disabled</Badge>;
  if (!status) return <Badge tip="Waiting for the shortcut to be registered with the system">Pending</Badge>;
  if (status.registered) return <Badge tone="ok" tip="The shortcut works from any app">Active</Badge>;
  const badge = <Badge tone="warn" tip="Another app already owns this shortcut; pick a different one">In use by another app</Badge>;
  return status.error ? <Tooltip label={status.error}>{badge}</Tooltip> : badge;
}

/** Settings → General: tray, login item and global shortcuts. */
export function SettingsGeneral() {
  const settings = useSettings((s) => s.settings);
  const statuses = useDesktop((s) => s.hotkeys);
  const [errors, setErrors] = useState<Record<string, string>>({});

  /** Applies a patch; field errors (`startAtLogin`, `hotkeys.<action>`) go inline. */
  const apply = async (patch: Partial<SettingsPatch>, keys: string[]) => {
    try {
      await useSettings.getState().update(patch);
      setErrors((e) => {
        const next = { ...e };
        for (const k of keys) delete next[k];
        return next;
      });
    } catch (e) {
      const err = toAppError(e);
      setErrors((prev) => {
        const next = { ...prev };
        for (const k of keys) delete next[k];
        let matched = false;
        for (const [field, msg] of Object.entries(err.fields ?? {})) {
          next[field] = msg;
          matched = true;
        }
        if (!matched) next[keys[0] ?? "general"] = err.message;
        return next;
      });
    }
  };

  const hotkeys = settings.hotkeys ?? {};
  const isDefault = HOTKEY_ROWS.every((r) => (hotkeys[r.action] ?? "") === (DEFAULT_HOTKEYS[r.action] ?? ""));

  return (
    <Section label="General" tip="Tray, start-up and global shortcuts">
      <div className={styles.stack}>
        <Switch
          checked={settings.keepInTray}
          onChange={(v) => void apply({ keepInTray: v }, ["keepInTray"])}
          label="Keep Toolbox running in the tray when the window is closed"
          tip="Closing the window hides it instead of quitting, so downloads and watch folders keep working"
        />
        {errors.keepInTray && (
          <p className={styles.error} role="alert">
            {errors.keepInTray}
          </p>
        )}
        <Switch
          checked={settings.startAtLogin}
          onChange={(v) => void apply({ startAtLogin: v }, ["startAtLogin"])}
          label="Start Toolbox at login"
          tip="Open Toolbox quietly in the tray each time you sign in to your computer"
        />
        {errors.startAtLogin && (
          <p className={styles.error} role="alert">
            {errors.startAtLogin}
          </p>
        )}

        <div className={styles.shortcutsHead}>
          <h3 className={styles.subtitle} data-tip="Key combinations that work even when Toolbox is in the background">Global shortcuts</h3>
          <Button
            size="sm"
            variant="ghost"
            disabled={isDefault}
            data-tip={isDefault ? "Shortcuts already have their default keys" : "Put every global shortcut back to its original keys"}
            onClick={() => void apply({ hotkeys: { ...DEFAULT_HOTKEYS } }, HOTKEY_ROWS.map((r) => `hotkeys.${r.action}`))}
          >
            Reset to defaults
          </Button>
        </div>
        <ul className={styles.shortcuts}>
          {HOTKEY_ROWS.map(({ action, label }) => {
            const accel = hotkeys[action] ?? "";
            const err = errors[`hotkeys.${action}`];
            return (
              <li key={action} className={styles.shortcut}>
                <span className={styles.shortcutLabel} data-tip={action === "clipboard" ? "Opens the clipboard history popup from anywhere" : "Opens the search palette from anywhere"}>{label}</span>
                <HotkeyRecorder
                  label={`${label} shortcut`}
                  value={accel}
                  onChange={(a) => void apply({ hotkeys: { [action]: a } }, [`hotkeys.${action}`])}
                />
                <span className={styles.status}>
                  <StatusBadge accelerator={accel} status={statuses.find((s) => s.action === action)} />
                </span>
                {err && (
                  <p className={styles.error} role="alert">
                    {err}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}
