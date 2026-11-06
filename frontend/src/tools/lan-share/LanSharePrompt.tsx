import { useEffect, useState } from "react";
import { Button, Icon, Switch, toast } from "@/components";
import { LanPromptKind, LanShareService, type LanPrompt } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useLanShare } from "@/state/lanshare";
import { Dialog } from "./Dialog";
import { formatPairCode, promptNames, promptSummary, secondsLeft } from "./model";
import styles from "./LanSharePrompt.module.css";

function useCountdown(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [expiresAt]);
  return secondsLeft(expiresAt, now);
}

function PromptDialog({ prompt }: { prompt: LanPrompt }) {
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const left = useCountdown(prompt.expiresAt);
  const close = useLanShare((s) => s.closePrompt);
  const { names, more } = promptNames(prompt);
  const alias = prompt.device.alias || "Another device";
  const pair = prompt.kind === LanPromptKind.PromptPair;
  const message = prompt.kind === LanPromptKind.PromptMessage;

  const respond = async (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await LanShareService.Respond(prompt.id, accept, accept && always && prompt.canAlways);
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    } finally {
      close(prompt.id);
    }
  };

  const title = pair ? `Pair with ${alias}?` : message ? `${alias} sent you a message` : `${alias} wants to send you files`;
  return (
    <Dialog
      title={title}
      width={440}
      onEscape={() => void respond(false)}
      onEnter={() => void respond(true)}
      footer={
        <>
          <span className={styles.countdown} role="timer" aria-label={`Answer within ${left} seconds`} data-tip="The request is declined when the time runs out">
            {left}s
          </span>
          <Button variant="secondary" disabled={busy} data-tip="Don't accept" data-tip-kbd="Esc" onClick={() => void respond(false)}>
            Decline
          </Button>
          <Button data-autofocus="" loading={busy} data-tip={pair ? "Pair these two computers" : "Accept and start receiving"} data-tip-kbd="Enter" onClick={() => void respond(true)}>
            {pair ? "Pair" : message ? "Show message" : "Accept"}
          </Button>
        </>
      }
    >
      <p className={styles.who}>
        <Icon name={prompt.verified ? "lock" : "shield"} size={14} className={prompt.verified ? styles.verified : styles.unverified} />
        {prompt.verified ? <span>{alias}</span> : <span>Can't confirm who this is</span>}
        {!prompt.verified && <span className={styles.claimed}>says it is {alias}</span>}
      </p>
      {pair ? (
        <>
          <p>Check that both screens show</p>
          <p className={styles.code} data-testid="pair-code">
            {formatPairCode(prompt.pairCode)}
          </p>
        </>
      ) : message ? (
        <p className={styles.text}>{prompt.text}</p>
      ) : (
        <>
          <p className={styles.summary}>{promptSummary(prompt)}</p>
          {names.length > 0 && (
            <ul className={styles.names}>
              {names.map((n, i) => (
                <li key={`${i}-${n}`}>{n}</li>
              ))}
              {more > 0 && <li className={styles.more}>and {more} more</li>}
            </ul>
          )}
          {prompt.text && <p className={styles.text}>{prompt.text}</p>}
        </>
      )}
      {prompt.canAlways && !pair && (
        <Switch checked={always} onChange={setAlways} label="Always accept from this device" tip="Next time this device sends, the files arrive without asking" />
      )}
    </Dialog>
  );
}

/** The incoming transfer, pairing and message prompts (SPEC §4.2): shown over any view, one at a time. */
export default function LanSharePrompt() {
  const prompt = useLanShare((s) => s.prompts[0]);
  if (!prompt) return null;
  return <PromptDialog key={prompt.id} prompt={prompt} />;
}
