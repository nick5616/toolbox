import { useEffect, useState } from "react";
import { Banner, Button, ClickInHost, Spinner } from "@/components";
import type { ToolViewProps } from "@/tools";
import { CreateForm, LockedForm, RecoveryScreen } from "./Gate";
import { UnlockedPanel } from "./UnlockedPanel";
import { useVaultState } from "./useVaultState";
import styles from "./vault.module.css";

export default function VaultView(_props: ToolViewProps) {
  const state = useVaultState();
  // Kept here (not derived from state) so the recovery screen survives the vault opening after Create.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  // The backend delivers the notice once (on the unlock state); latch it until dismissed or the vault locks.
  const [notice, setNotice] = useState("");
  const stateNotice = state?.notice ?? "";
  const unlocked = state?.unlocked ?? false;
  useEffect(() => {
    if (stateNotice) setNotice(stateNotice);
  }, [stateNotice]);
  useEffect(() => {
    if (!unlocked) setNotice("");
  }, [unlocked]);

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
    <ClickInHost>
    <section className={styles.root} aria-label="Vault">
      {notice && unlocked && (
        <Banner
          tone="info"
          action={
            <Button size="sm" variant="secondary" data-tip="Hide this message" onClick={() => setNotice("")}>
              Dismiss
            </Button>
          }
        >
          {notice}
        </Banner>
      )}
      {body}
    </section>
    </ClickInHost>
  );
}
