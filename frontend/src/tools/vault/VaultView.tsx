import { useState } from "react";
import { Spinner } from "@/components";
import type { ToolViewProps } from "@/tools";
import { CreateForm, LockedForm, RecoveryScreen } from "./Gate";
import { UnlockedPanel } from "./UnlockedPanel";
import { useVaultState } from "./useVaultState";
import styles from "./vault.module.css";

export default function VaultView(_props: ToolViewProps) {
  const state = useVaultState();
  // Kept here (not derived from state) so the recovery screen survives the vault opening after Create.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  let body;
  if (recoveryKey !== null) {
    body = <RecoveryScreen recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />;
  } else if (!state) {
    body = <Spinner label="Loading" />;
  } else if (!state.exists) {
    body = <CreateForm onCreated={setRecoveryKey} />;
  } else if (!state.unlocked) {
    body = <LockedForm />;
  } else {
    body = <UnlockedPanel state={state} />;
  }

  return (
    <section className={styles.root} aria-label="Vault">
      <header>
        <h1 className={styles.title}>Vault</h1>
        <p className={styles.tagline}>Keep private files encrypted on this computer</p>
      </header>
      {body}
    </section>
  );
}
