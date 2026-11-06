import { useEffect, useMemo, useState, type DragEvent } from "react";
import { Badge, Banner, Button, Icon, IconButton, Switch, TextField, cx } from "@/components";
import type { LanDevice } from "@/lib/api";
import { PATHS_MIME } from "@/lib/fileDrag";
import { groupDevices } from "@/state/lanshare";
import { DEVICE_DROP_PREFIX, deviceIcon, parseAddress, seenLabel } from "./model";
import styles from "./LanShareView.module.css";

export interface DevicesPanelProps {
  devices: readonly LanDevice[];
  /** Files or text are waiting: "Send…" sends them, else it picks files first. */
  hasPayload: boolean;
  onSend: (d: LanDevice) => void;
  /** A text drag landed on a device: send it as a message. */
  onSendText: (d: LanDevice, text: string) => void;
  onPair: (d: LanDevice) => void;
  onForget: (d: LanDevice) => void;
  onAutoAccept: (d: LanDevice, on: boolean) => void;
  onScan: () => void;
  onAddAddress: (host: string, port: number) => Promise<void>;
  /** Show the firewall hint under the list. */
  firewallHint: string;
}

function isVerified(d: LanDevice): boolean {
  return d.paired || d.toolbox;
}

function DeviceRow({ d, hasPayload, onSend, onSendText, onPair, onForget, onAutoAccept }: { d: LanDevice } & Pick<DevicesPanelProps, "hasPayload" | "onSend" | "onSendText" | "onPair" | "onForget" | "onAutoAccept">) {
  const [over, setOver] = useState(false);
  // A text drag (not files) is a message; files are routed by the shell through data-file-drop-target.
  const isTextDrag = (e: DragEvent) => {
    const t = e.dataTransfer?.types ?? [];
    return t.includes("text/plain") && !t.includes(PATHS_MIME) && !t.includes("Files");
  };
  return (
    <li
      id={`${DEVICE_DROP_PREFIX}${d.fingerprint}`}
      data-file-drop-target=""
      data-testid={`device-${d.fingerprint}`}
      className={cx(styles.device, over && styles.deviceOver, !d.online && styles.offline)}
      onDragOver={(e) => {
        if (!isTextDrag(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!isTextDrag(e)) return;
        e.preventDefault();
        const text = e.dataTransfer.getData("text/plain");
        if (text.trim()) onSendText(d, text);
      }}
    >
      <Icon name={deviceIcon(d.deviceType)} size={16} className={styles.deviceIcon} />
      <span className={styles.deviceName} data-tip={d.deviceModel ? `${d.alias} · ${d.deviceModel}` : d.alias}>
        {d.alias}
      </span>
      <Badge tone={d.toolbox ? "accent" : "neutral"} tip={d.toolbox ? "Runs Toolbox: can be paired" : "The LocalSend app: its owner is asked for every transfer"}>
        {d.toolbox ? "Toolbox" : "LocalSend"}
      </Badge>
      {isVerified(d) && (
        <span className={styles.lock} data-tip="Its identity is verified">
          <Icon name="lock" size={12} title="Verified" />
        </span>
      )}
      {d.autoAccept && (
        <Badge tone="ok" tip="Files from this device arrive without asking">
          Auto-accept
        </Badge>
      )}
      <span className={styles.seen} data-tip={d.address ? `${d.address}:${d.port}` : undefined}>
        <span className={cx(styles.dot, d.online && styles.dotOnline)} aria-hidden="true" />
        {seenLabel(d)}
      </span>
      <span className={styles.rowActions}>
        {d.toolbox && d.paired && (
          <Switch checked={d.autoAccept} onChange={(on) => onAutoAccept(d, on)} aria-label={`Accept from ${d.alias} without asking`} tip="Accept files from this device without asking" />
        )}
        {d.toolbox && !d.paired && d.online && (
          <Button size="sm" variant="ghost" icon="link" data-tip="Pair these two computers so they trust each other" onClick={() => onPair(d)}>
            Pair
          </Button>
        )}
        <Button size="sm" variant="secondary" icon="send" data-tip={hasPayload ? "Send the waiting files to this device" : "Choose files and send them to this device"} onClick={() => onSend(d)}>
          Send…
        </Button>
        {d.stored && <IconButton size="sm" icon="trash-2" label={`Forget ${d.alias}`} onClick={() => onForget(d)} />}
      </span>
    </li>
  );
}

/** The devices list (SPEC §6.1): grouped dense rows, each a file drop target, plus Add by address and Refresh. */
export function DevicesPanel(p: DevicesPanelProps) {
  const groups = useMemo(() => groupDevices(p.devices), [p.devices]);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // Re-render the "seen N min ago" labels.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const parsed = parseAddress(address);
  const add = async () => {
    if (!parsed || busy) return;
    setBusy(true);
    setProblem("");
    try {
      await p.onAddAddress(parsed.host, parsed.port);
      setAdding(false);
      setAddress("");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't reach that address");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-label="Devices">
      <header className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Devices</h2>
        <IconButton size="sm" icon="refresh-cw" label="Refresh" tooltipSide="bottom" onClick={p.onScan} />
      </header>
      {groups.length === 0 ? (
        <p className={styles.empty}>No devices yet. Open Toolbox or LocalSend on your other device, turn on receiving there, then Refresh.</p>
      ) : (
        groups.map((g) => (
          <div key={g.group} className={styles.group}>
            <div className={styles.groupLabel}>{g.label}</div>
            <ul className={styles.deviceList}>
              {g.devices.map((d) => (
                <DeviceRow key={d.fingerprint} d={d} hasPayload={p.hasPayload} onSend={p.onSend} onSendText={p.onSendText} onPair={p.onPair} onForget={p.onForget} onAutoAccept={p.onAutoAccept} />
              ))}
            </ul>
          </div>
        ))
      )}
      {p.firewallHint && <Banner tone="info">{p.firewallHint}</Banner>}
      <div className={styles.addRow}>
        {adding ? (
          <>
            <TextField
              size="sm"
              autoFocus
              placeholder="192.168.1.20 or 192.168.1.20:53317"
              aria-label="Device address"
              value={address}
              invalid={address !== "" && !parsed}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
                if (e.key === "Escape") setAdding(false);
              }}
            />
            <Button size="sm" loading={busy} aria-disabled={!parsed} data-tip={parsed ? "Look for a device at this address" : "Type an address first"} onClick={() => void add()}>
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" icon="plus" data-tip="Add a device that doesn't show up by itself" onClick={() => setAdding(true)}>
            Add by address…
          </Button>
        )}
      </div>
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
