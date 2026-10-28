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
  if (!accelerator) return <Badge>Disabled</Badge>;
  if (!status) return <Badge>Pending</Badge>;
  if (status.registered) return <Badge tone="ok">Active</Badge>;
  const badge = <Badge tone="warn">In use by another app</Badge>;
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
    <Section label="General">
      <div className={styles.stack}>
        <Switch
          checked={settings.keepInTray}
          onChange={(v) => void apply({ keepInTray: v }, ["keepInTray"])}
          label="Keep Toolbox running in the tray when the window is closed"
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
        />
        {errors.startAtLogin && (
          <p className={styles.error} role="alert">
            {errors.startAtLogin}
          </p>
        )}

        <div className={styles.shortcutsHead}>
          <h3 className={styles.subtitle}>Global shortcuts</h3>
          <Button
            size="sm"
            variant="ghost"
            disabled={isDefault}
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
                <span className={styles.shortcutLabel}>{label}</span>
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
