import { useEffect, useRef, useState } from "react";
import { Button, Icon, Spinner, TextField, cx } from "@/components";
import { LanShareService, type LanDevice } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { Dialog } from "./Dialog";
import { deviceIcon, describeFiles, formatPairCode, seenLabel, sendTargets } from "./model";
import styles from "./Dialogs.module.css";

/** The sender's side of pairing: "Waiting for <alias>…", then the code both screens show. */
export function PairDialog({ device, onClose }: { device: LanDevice; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    let live = true;
    LanShareService.Pair(device.fingerprint).then(
      (c) => live && setCode(c),
      (e: unknown) => {
        if (!live || cancelled.current) return;
        const err = toAppError(e);
        setError(err.hint ? `${err.message} ${err.hint}` : err.message);
      },
    );
    return () => {
      live = false;
    };
  }, [device.fingerprint]);

  const cancel = () => {
    cancelled.current = true;
    if (!code) void LanShareService.CancelPair().catch(() => undefined);
    onClose();
  };
  const done = code !== "";
  return (
    <Dialog
      title={done ? `Paired with ${device.alias}` : `Pair with ${device.alias}`}
      onEscape={cancel}
      onEnter={done || error ? onClose : undefined}
      footer={
        done || error ? (
          <Button data-autofocus="" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button variant="secondary" data-tip="Stop waiting for the other device" onClick={cancel}>
            Cancel
          </Button>
        )
      }
    >
      {error ? (
        <p role="alert">{error}</p>
      ) : done ? (
        <>
          <p>Both screens show this code.</p>
          <p className={styles.code} data-testid="pair-code">
            {formatPairCode(code)}
          </p>
        </>
      ) : (
        <p className={styles.waiting}>
          <Spinner size={14} /> Waiting for {device.alias}…
        </p>
      )}
    </Dialog>
  );
}

/** Which device to send to, when the files were chosen from the header. */
export function ChooseDeviceDialog({ devices, count, hasText, onChoose, onClose }: { devices: readonly LanDevice[]; count: number; hasText: boolean; onChoose: (d: LanDevice) => void; onClose: () => void }) {
  const list = sendTargets(devices);
  const what = count > 0 ? describeFiles(count) : hasText ? "your message" : "";
  return (
    <Dialog title={`Send ${what} to…`} onEscape={onClose} onBackdrop={onClose} footer={<Button variant="secondary" onClick={onClose}>Cancel</Button>}>
      {list.length === 0 ? (
        <p>No devices yet. Open Toolbox or LocalSend on your other device, turn on receiving there, then Refresh.</p>
      ) : (
        <ul className={styles.choices}>
          {list.map((d, i) => (
            <li key={d.fingerprint}>
              <button type="button" data-autofocus={i === 0 ? "" : undefined} className={cx(styles.choice, !d.online && styles.offline)} onClick={() => onChoose(d)}>
                <Icon name={deviceIcon(d.deviceType)} size={16} />
                <span className={styles.choiceName}>{d.alias}</span>
                <span className={styles.choiceSeen}>{seenLabel(d)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** The receiver wants a PIN: ask inline and send again. */
export function PinDialog({ alias, onSubmit, onClose }: { alias: string; onSubmit: (pin: string) => void; onClose: () => void }) {
  const [pin, setPin] = useState("");
  const go = () => pin && onSubmit(pin);
  return (
    <Dialog
      title={`${alias} needs a PIN`}
      onEscape={onClose}
      onEnter={go}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button aria-disabled={pin === ""} data-tip={pin ? "Send with this PIN" : "Type the PIN shown on the other device's settings"} onClick={go}>
            Send
          </Button>
        </>
      }
    >
      <p>Type the PIN set in {alias}'s Local File Transfer settings.</p>
      <TextField aria-label="PIN" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\s/g, ""))} />
    </Dialog>
  );
}
