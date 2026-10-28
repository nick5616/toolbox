import { Section, Switch, toast } from "@/components";
import { toAppError } from "@/lib/errors";
import { useSettings } from "@/state/settings";
import { ClipboardSettingsPanel } from "@/tools/clipboard/ClipboardSettingsPanel";
import styles from "./SettingsGeneral.module.css";

/** Settings → Clipboard: master switch, privacy note and the tool's settings panel. */
export function SettingsClipboard() {
  const clip = useSettings((s) => s.settings.clipboard);

  const toggle = (enabled: boolean) => {
    useSettings
      .getState()
      .update({ clipboard: { ...clip, enabled } })
      .catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
  };

  return (
    <Section label="Clipboard">
      <div className={styles.stack}>
        <Switch checked={clip.enabled} onChange={toggle} label="Enable clipboard history" />
        <ClipboardSettingsPanel />
        <p className={styles.note}>
          Clipboard history stays on this computer. Copies marked sensitive by password managers are never recorded,
          and Toolbox never pastes into other apps.
        </p>
      </div>
    </Section>
  );
}
