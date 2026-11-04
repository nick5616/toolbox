import { useState, type FormEvent } from "react";
import { Banner, Button, Field, Switch, TextField, toast } from "@/components";
import { VaultService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { passphraseStrength } from "./useVaultState";
import styles from "./vault.module.css";

export const MIN_PASSPHRASE = 8;

export function RecoveryKeyBox({ recoveryKey }: { recoveryKey: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      toast({ title: "Recovery key copied", tone: "success" });
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
  return (
    <>
      <div className={styles.keyBox} data-testid="recovery-key" data-tip="Your recovery key: it opens the vault if you forget the passphrase">
        {recoveryKey}
      </div>
      <div className={styles.actions}>
        <Button size="sm" variant="secondary" icon="copy" data-tip="Copy the recovery key so you can store it in a password manager" onClick={() => void copy()}>
          Copy
        </Button>
      </div>
    </>
  );
}

/** No vault yet: explainer plus the create form. */
export function CreateForm({ onCreated }: { onCreated: (recoveryKey: string) => void }) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const strength = passphraseStrength(pass);
  const mismatch = confirm !== "" && confirm !== pass;
  const canCreate = pass.length >= MIN_PASSPHRASE && confirm === pass && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError("");
    try {
      onCreated(await VaultService.Create(pass));
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ul className={styles.list}>
        <li>File names, folders and contents are encrypted. File count and approximate sizes stay visible on disk.</li>
        <li>Forgetting the passphrase means losing the files unless you kept the recovery key.</li>
        <li>Adding files copies them; your originals stay where they are. Delete them yourself if you want.</li>
      </ul>
      <form className={styles.narrow} onSubmit={(e) => void submit(e)}>
        <Field label="Passphrase">
          {(c) => <TextField {...c} data-tip={`Choose a passphrase of at least ${MIN_PASSPHRASE} characters; a few random words work well`} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />}
        </Field>
        {pass !== "" && (
          <p data-tip="A rough guess of how hard this passphrase is to crack" className={`${styles.strength} ${styles[`strength${strength.level}`]}`} aria-live="polite">
            {strength.label}
          </p>
        )}
        <Field label="Confirm passphrase" error={mismatch ? "Passphrases don't match" : undefined}>
          {(c) => (
            <TextField {...c} data-tip="Type the same passphrase again to be sure it is right" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          )}
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" icon="lock" loading={busy} disabled={!canCreate} data-tip={canCreate ? "Create the encrypted vault with this passphrase" : pass.length < MIN_PASSPHRASE ? `The passphrase needs at least ${MIN_PASSPHRASE} characters` : "Both passphrases must match"}>
            Create vault
          </Button>
        </div>
      </form>
    </>
  );
}

/** Shown once after creation; the vault only opens after the user confirms. */
export function RecoveryScreen({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className={styles.narrow}>
      <Banner tone="warn" title="Save your recovery key">
        Save this somewhere safe. It's the only way in if you forget your passphrase.
      </Banner>
      <RecoveryKeyBox recoveryKey={recoveryKey} />
      <Switch checked={saved} onChange={setSaved} label="I've saved it" tip="Confirm you stored the recovery key; you cannot see it again without your passphrase" />
      <div className={styles.actions}>
        <Button variant="primary" disabled={!saved} data-tip={saved ? "Continue to your vault" : "Save the recovery key and switch on \"I've saved it\" first"} onClick={onDone}>
          Open vault
        </Button>
      </div>
    </div>
  );
}

/** Locked: passphrase (or recovery key) and Unlock. */
export function LockedForm() {
  const [secret, setSecret] = useState("");
  const [useKey, setUseKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (secret === "" || busy) return;
    setBusy(true);
    setError("");
    try {
      await VaultService.Unlock(secret.trim());
      setSecret("");
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const label = useKey ? "Recovery key" : "Passphrase";
  return (
    <form className={styles.narrow} onSubmit={(e) => void submit(e)}>
      <Field label={label} error={error || undefined}>
        {(c) => (
          <TextField
            {...c}
            type="password"
            autoFocus
            autoComplete="current-password"
            mono={useKey}
            data-tip={useKey ? "Paste the recovery key you saved when you created the vault" : "The passphrase you chose when you created the vault"}
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              setError("");
            }}
          />
        )}
      </Field>
      <div className={styles.actions}>
        <Button type="submit" variant="primary" icon="lock" loading={busy} disabled={secret === ""} data-tip="Decrypt and open the vault">
          Unlock
        </Button>
        <button
          type="button"
          className={styles.linkButton}
          data-tip={useKey ? "Go back to unlocking with your passphrase" : "Forgot your passphrase? Unlock with the recovery key instead"}
          onClick={() => {
            setUseKey((v) => !v);
            setSecret("");
            setError("");
          }}
        >
          {useKey ? "Use passphrase" : "Use recovery key"}
        </button>
      </div>
    </form>
  );
}
