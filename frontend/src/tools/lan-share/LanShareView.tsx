import { useCallback, useEffect, useMemo, useState } from "react";
import { FromLibraryButton, pickFromLibrary } from "@/blocks/library-picker";
import { Button, ClickIn, ClickInHost, Icon, IconButton, SegmentedControl, TextField, ToolHeader, toast } from "@/components";
import { FilesService, LanReceiveMode, LanShareService, type LanDevice } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { useToolHandoff } from "@/lib/embed";
import { toAppError } from "@/lib/errors";
import { registerDropTarget } from "@/lib/dropTargets";
import { isMac } from "@/lib/platform";
import { useElementSize } from "@/lib/useElementSize";
import { currentWindow } from "@/lib/windows";
import { useOrderedJobs } from "@/state/jobs";
import { LAN_RECEIVE_MODULE_ID, useLanShare } from "@/state/lanshare";
import type { ToolViewProps } from "@/tools";
import { ActivityPanel } from "./ActivityPanel";
import { MODULE_ID } from "./constants";
import { DevicesPanel } from "./DevicesPanel";
import { ChooseDeviceDialog, PairDialog, PinDialog } from "./Dialogs";
import {
  DEVICE_DROP_PREFIX,
  FIREWALL_HINT_MS,
  HOLD_INTERVAL_MS,
  RECEIVE_OPTIONS,
  WIDE_WIDTH,
  describeFiles,
  firewallHint,
  isPinRequired,
  mergeQueue,
  queueSummary,
  receivingAddress,
  receivingLabel,
} from "./model";
import { SettingsPanel } from "./SettingsPanel";
import styles from "./LanShareView.module.css";

function report(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

interface PinAsk {
  device: LanDevice;
  paths: string[];
  text: string;
  fromQueue: boolean;
}

/** Keeps "While open" receiving on while this view is mounted and visible. */
function useHold(): void {
  useEffect(() => {
    const key = currentWindow().key;
    const beat = () => {
      if (document.visibilityState === "visible") void LanShareService.Hold(key).catch(() => undefined);
    };
    beat();
    const id = setInterval(beat, HOLD_INTERVAL_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", beat);
      void LanShareService.Release(key).catch(() => undefined);
    };
  }, []);
}

/** True once a listening computer has been unseen by everyone for FIREWALL_HINT_MS. */
function useFirewallHint(listening: boolean, anyOnline: boolean): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!listening || anyOnline) {
      setShow(false);
      return;
    }
    const id = setTimeout(() => setShow(true), FIREWALL_HINT_MS);
    return () => clearTimeout(id);
  }, [listening, anyOnline]);
  return show;
}

export default function LanShareView({ moduleId }: ToolViewProps) {
  const state = useLanShare((s) => s.state);
  const devices = useLanShare((s) => s.devices);
  const messages = useLanShare((s) => s.messages);
  const notes = useLanShare((s) => s.activity);
  const sends = useOrderedJobs(MODULE_ID);
  const receives = useOrderedJobs(LAN_RECEIVE_MODULE_ID);

  const [queue, setQueue] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [pairing, setPairing] = useState<LanDevice | null>(null);
  const [pinAsk, setPinAsk] = useState<PinAsk | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const { width } = useElementSize(root);
  const wide = width >= WIDE_WIDTH;

  useHold();
  const anyOnline = devices.some((d) => d.online);
  const showFirewall = useFirewallHint(state.listening, anyOnline);

  const addPaths = useCallback((paths: readonly string[]) => setQueue((q) => mergeQueue(q, paths)), []);

  useToolHandoff(MODULE_ID, (h) => addPaths(h.inputs));

  const pick = useCallback(async (): Promise<string[]> => {
    try {
      const picked = (await FilesService.PickWith("Choose files to send", null, true)) ?? [];
      if (picked.length > 0) addPaths(picked);
      return picked;
    } catch (e) {
      report(e);
      return [];
    }
  }, [addPaths]);

  /** Files Toolbox already made (the Library): queued like a native pick. */
  const pickLibrary = useCallback(async () => {
    const picked = await pickFromLibrary({ title: "Choose files to send from Library", exts: null, multiple: true, have: queue });
    if (picked.length > 0) addPaths(picked);
  }, [addPaths, queue]);

  const addFolder = async () => {
    try {
      const dir = await FilesService.PickFolder("Choose a folder to send");
      if (dir) addPaths([dir]);
    } catch (e) {
      report(e);
    }
  };

  const send = useCallback(
    async (device: LanDevice, paths: string[], message: string, fromQueue: boolean, pin = "") => {
      try {
        await LanShareService.Send({ fingerprint: device.fingerprint, paths, text: message, pin });
        if (fromQueue) {
          setQueue([]);
          setText("");
        }
        toast({ tone: "success", title: `Sending to ${device.alias}`, description: paths.length > 0 ? describeFiles(paths.length) : "A message" });
      } catch (e) {
        const err = toAppError(e);
        if (isPinRequired(err)) setPinAsk({ device, paths, text: message, fromQueue });
        else report(e);
      }
    },
    [],
  );

  // Files dropped on a device row (OS drops and in-app drags): sent to that device. The shell's drop routing asks lib/dropTargets first, so the drop never also lands in the queue.
  useEffect(
    () =>
      registerDropTarget(DEVICE_DROP_PREFIX, (fp, paths) => {
        const device = useLanShare.getState().devices.find((x) => x.fingerprint === fp);
        if (!device || paths.length === 0) return;
        void send(device, paths, "", false);
      }),
    [send],
  );

  const hasPayload = queue.length > 0 || text.trim() !== "";

  const startSend = useCallback(async () => {
    if (queue.length === 0 && text.trim() === "") {
      const picked = await pick();
      if (picked.length === 0) return;
    }
    setChoosing(true);
  }, [queue.length, text, pick]);

  // "Send files to a device…" from the palette.
  const sendPending = useLanShare((s) => s.sendPending);
  useEffect(() => {
    if (sendPending && useLanShare.getState().takeSendRequest()) void startSend();
  }, [sendPending, startSend]);

  useCommands([
    { id: "tool.addFiles", title: "Add files…", section: "Actions", shortcut: "Mod+O", icon: "plus", run: () => void pick() },
    { id: "lanshare.addFilesLibrary", title: "Add files to send from Library…", section: "Actions", icon: "history", run: () => void pickLibrary() },
  ]);

  const sendToDevice = (d: LanDevice) => {
    if (queue.length === 0 && text.trim() === "") {
      void pick().then((picked) => {
        if (picked.length > 0) void send(d, picked, text.trim(), true);
      });
      return;
    }
    void send(d, queue, text.trim(), true);
  };

  const setMode = (mode: LanReceiveMode) => void LanShareService.SetReceive(mode).catch(report);
  const label = receivingLabel(state);
  const address = receivingAddress(state);

  const clearMessages = () => {
    useLanShare.getState().clearMessagesLocal();
    void LanShareService.ClearMessages().catch(report);
  };

  const bottom = useMemo(() => {
    const parts = ["This computer", state.alias || "…"];
    if (state.shortCode) parts.push(state.shortCode);
    if (state.listening && state.port) parts.push(`port ${state.port}`);
    return parts.join(" · ");
  }, [state.alias, state.shortCode, state.listening, state.port]);

  return (
    <ClickInHost className={styles.hostWrap}>
      <div ref={setRoot} className={styles.root} data-module={moduleId} data-wide={wide ? "" : undefined}>
        <ToolHeader aria-label="Local File Transfer">
          <SegmentedControl
            aria-label="Receive files"
            size="sm"
            value={state.mode === LanReceiveMode.$zero ? LanReceiveMode.ReceiveOff : state.mode}
            options={RECEIVE_OPTIONS}
            onChange={setMode}
          />
          {label && (
            <span className={state.error ? styles.listenError : styles.listening} data-testid="receiving" data-tip={state.error ? "Receiving couldn't start" : address ? `Other devices send to ${address}:${state.port}` : undefined}>
              {!state.error && <span className={styles.listenDot} aria-hidden="true" />}
              {label}
            </span>
          )}
          <span className={styles.spacer} />
          <Button size="sm" icon="send" collapsible data-tip="Choose files and a device to send them to" onClick={() => void startSend()}>
            Send…
          </Button>
        </ToolHeader>

        {hasPayload && (
          <div className={styles.queue} data-testid="queue">
            <Icon name="arrow-left-right" size={14} />
            <span className={styles.queueText}>{queue.length > 0 ? queueSummary(queue.length) : "Message ready — click Send on a device"}</span>
            <FromLibraryButton iconOnly size="sm" variant="ghost" title="Choose files to send from Library" label="Add files from Library…" exts={null} have={queue} onPick={addPaths} />
            <Button size="sm" variant="ghost" icon="plus" data-tip="Add another folder" onClick={() => void addFolder()}>
              Folder
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-tip="Forget the waiting files and message"
              onClick={() => {
                setQueue([]);
                setText("");
              }}
            >
              Clear
            </Button>
          </div>
        )}
        <div className={styles.messageRow}>
          <TextField
            size="sm"
            aria-label="Message"
            placeholder="Send text…"
            value={text}
            maxLength={65536}
            onChange={(e) => setText(e.target.value)}
          />
          {queue.length === 0 && (
            <>
              <IconButton size="sm" icon="plus" label="Add files…" kbd="Mod+O" onClick={() => void pick()} />
              <FromLibraryButton iconOnly size="sm" title="Choose files to send from Library" label="Add files from Library…" exts={null} onPick={addPaths} />
            </>
          )}
        </div>

        <div className={styles.body}>
          <DevicesPanel
            devices={devices}
            hasPayload={hasPayload}
            onSend={sendToDevice}
            onSendText={(d, t) => void send(d, [], t, false)}
            onPair={setPairing}
            onForget={(d) => void LanShareService.Forget(d.fingerprint).catch(report)}
            onAutoAccept={(d, on) => void LanShareService.SetAutoAccept(d.fingerprint, on).catch(report)}
            onScan={() => void LanShareService.Scan().catch(report)}
            onAddAddress={async (host, port) => {
              await LanShareService.AddByAddress(host, port);
            }}
            firewallHint={showFirewall ? firewallHint(isMac) : ""}
          />
          <ActivityPanel sends={sends} receives={receives} messages={messages} notes={notes} onClearMessages={clearMessages} />
        </div>

        <footer className={styles.bottomBar}>
          <span className={styles.bottomText} data-tip="This computer's name, short code and port, as other devices see them">
            {bottom}
          </span>
          <ClickIn icon="settings" title="Settings" summary={state.from === "mine" ? "Only my devices" : "Anyone nearby"} variant="row" width={360} tip="Name, who can send, PIN, the Received folder">
            <SettingsPanel pinSet={state.pinSet} />
          </ClickIn>
        </footer>
      </div>

      {choosing && (
        <ChooseDeviceDialog
          devices={devices}
          count={queue.length}
          hasText={text.trim() !== ""}
          onClose={() => setChoosing(false)}
          onChoose={(d) => {
            setChoosing(false);
            void send(d, queue, text.trim(), true);
          }}
        />
      )}
      {pairing && <PairDialog device={pairing} onClose={() => setPairing(null)} />}
      {pinAsk && (
        <PinDialog
          alias={pinAsk.device.alias}
          onClose={() => setPinAsk(null)}
          onSubmit={(pin) => {
            const a = pinAsk;
            setPinAsk(null);
            void send(a.device, a.paths, a.text, a.fromQueue, pin);
          }}
        />
      )}
    </ClickInHost>
  );
}
