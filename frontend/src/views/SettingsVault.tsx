import { useState } from "react";
import { Button, ConfirmDialog, Field, Section, Select, TextField, toast } from "@/components";
import { LibraryService, VaultService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useSettings } from "@/state/settings";
import { MIN_PASSPHRASE, RecoveryKeyBox } from "@/tools/vault/Gate";
import { useVaultState } from "@/tools/vault/useVaultState";
import styles from "./SettingsVault.module.css";

const AUTO_LOCK_OPTIONS = [
  { value: "1", label: "After 1 minute" },
  { value: "5", label: "After 5 minutes" },
  { value: "10", label: "After 10 minutes" },
  { value: "30", label: "After 30 minutes" },
  { value: "60", label: "After 1 hour" },
  { value: "0", label: "Only when I lock it or quit" },
];

function PassphraseChange({ onClose }: { onClose: () => void }) {
  const [oldPass, setOldPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    if (newPass.length < MIN_PASSPHRASE) return setError(`The new passphrase needs at least ${MIN_PASSPHRASE} characters`);
    if (newPass !== confirm) return setError("Passphrases don't match");
    try {
      await VaultService.ChangePassphrase(oldPass, newPass);
      toast({ title: "Passphrase changed", tone: "success" });
      onClose();
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  return (
    <ConfirmDialog
      open
      title="Change passphrase"
      confirmLabel="Change passphrase"
      onConfirm={() => void submit()}
      onCancel={onClose}
      body={
        <div className={styles.body}>
          <Field label="Current passphrase">
            {(c) => <TextField {...c} type="password" autoFocus value={oldPass} onChange={(e) => setOldPass(e.target.value)} />}
          </Field>
          <Field label="New passphrase">
            {(c) => <TextField {...c} type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} />}
          </Field>
          <Field label="Confirm new passphrase">
            {(c) => <TextField {...c} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
          </Field>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>
      }
    />
  );
}

function ShowRecoveryKey({ onClose }: { onClose: () => void }) {
  const [pass, setPass] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  const submit = async () => {
    if (key !== null) return onClose();
    try {
      setKey(await VaultService.RecoveryKey(pass));
      setPass("");
      setError("");
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  return (
    <ConfirmDialog
      open
      title="Recovery key"
      confirmLabel={key === null ? "Show key" : "Done"}
      onConfirm={() => void submit()}
      onCancel={onClose}
      body={
        key === null ? (
          <div className={styles.body}>
            <Field label="Passphrase" error={error || undefined}>
              {(c) => <TextField {...c} type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />}
            </Field>
          </div>
        ) : (
          <div className={styles.body}>
            <p className={styles.note}>Keep this somewhere safe. It's the only way in if you forget your passphrase.</p>
            <RecoveryKeyBox recoveryKey={key} />
          </div>
        )
      }
    />
  );
}

/** Settings → Vault: auto-lock, passphrase, recovery key and the folder on disk. */
export function SettingsVault() {
  const vault = useSettings((s) => s.settings.vault);
  const libraryDir = useSettings((s) => s.settings.libraryDir);
  const state = useVaultState();
  const [dialog, setDialog] = useState<"passphrase" | "key" | null>(null);
  const exists = state?.exists ?? false;

  const setAutoLock = (v: string) => {
    useSettings
      .getState()
      .update({ vault: { ...vault, autoLockMinutes: Number(v) } })
      .catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
  };

  const reveal = () => {
    const sep = libraryDir.includes("\\") ? "\\" : "/";
    LibraryService.RevealPath(`${libraryDir.replace(/[\\/]+$/, "")}${sep}Vault`).catch((e: unknown) =>
      toast({ tone: "danger", title: toAppError(e).message }),
    );
  };

  return (
    <Section label="Vault">
      <div className={styles.stack}>
        <div className={styles.row}>
          <span id="vault-autolock-label" className={styles.label}>
            Auto-lock
          </span>
          <Select
            aria-labelledby="vault-autolock-label"
            value={String(vault.autoLockMinutes)}
            options={AUTO_LOCK_OPTIONS}
            onChange={setAutoLock}
          />
        </div>
        <div className={styles.row}>
          <Button size="sm" variant="secondary" disabled={!exists} onClick={() => setDialog("passphrase")}>
            Change passphrase…
          </Button>
          <Button size="sm" variant="secondary" disabled={!exists} onClick={() => setDialog("key")}>
            Show recovery key…
          </Button>
          <Button size="sm" variant="secondary" disabled={!exists} onClick={reveal}>
            Reveal vault folder
          </Button>
        </div>
        {!exists && <p className={styles.note}>No vault yet. Create one from the Vault tool.</p>}
      </div>
      {dialog === "passphrase" && <PassphraseChange onClose={() => setDialog(null)} />}
      {dialog === "key" && <ShowRecoveryKey onClose={() => setDialog(null)} />}
    </Section>
  );
}
