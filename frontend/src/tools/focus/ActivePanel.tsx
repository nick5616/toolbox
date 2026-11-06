import { useEffect, useState } from "react";
import { AppIcon } from "@/blocks/app-picker";
import { Badge, Button, Section, cx } from "@/components";
import { FocusService, FocusStrength, FocusWeaken, type FocusBlockedApp, type FocusOpenApp, type FocusSession } from "@/lib/api";
import { useFocus } from "@/state/focus";
import { blockedResultLabel, secondsUntil, formatClock, formatLength, formatMmSs, formatWhen, strengthLabel, MAC_LINE } from "./model";
import { report } from "./useFocusData";
import styles from "./ActivePanel.module.css";

const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

function useNow(intervalMs: number, now: () => number): number {
  const [t, setT] = useState(() => now());
  useEffect(() => {
    setT(now());
    const id = setInterval(() => setT(now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, now]);
  return t;
}

export interface ActivePanelProps {
  session: FocusSession;
  blocked: readonly FocusBlockedApp[];
  stillOpen: readonly FocusOpenApp[];
  mac: boolean;
  now?: () => number;
}

/** Starts a weakening: the engine returns the friction, which the view's dialog shows. */
export async function requestWeaken(action: FocusWeaken, rule: Parameters<typeof FocusService.RequestWeaken>[1] = null): Promise<void> {
  try {
    const friction = await FocusService.RequestWeaken(action, rule);
    const st = useFocus.getState();
    st.setState({ ...st.state, friction });
    st.setFrictionHidden(false);
  } catch (e) {
    report(e);
  }
}

function pendingLabel(a: FocusWeaken): string {
  switch (a) {
    case FocusWeaken.WeakenEmergency:
      return "Emergency unlock";
    case FocusWeaken.WeakenQuit:
      return "Quitting Toolbox";
    case FocusWeaken.WeakenAllow:
      return "Allowing an app";
    default:
      return "Ending early";
  }
}

/** Active: the countdown ring, extend / end controls, what was stopped and what is still open (SPEC §5.1). */
export function ActivePanel({ session, blocked, stillOpen, mac, now = Date.now }: ActivePanelProps) {
  const t = useNow(1000, now);
  const total = Math.max(1, session.endsAt - session.startedAt);
  const left = Math.max(0, session.endsAt - t);
  const strict = session.strength === FocusStrength.StrengthStrict;
  const friction = useFocus((s) => s.state.friction);
  const frictionHidden = useFocus((s) => s.frictionHidden);
  const dash = RING_C * Math.min(1, left / total);

  const extend = (m: number) => void FocusService.Extend(m).catch(report);
  const allow = async (b: FocusBlockedApp) => {
    try {
      const app = await FocusService.AppFor(b.path);
      await requestWeaken(FocusWeaken.WeakenAllow, app.rule);
    } catch (e) {
      report(e);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.top}>
        <div className={styles.ring} role="timer" aria-label={`${formatLength(left)} left`}>
          <svg viewBox="0 0 120 120" width="132" height="132" aria-hidden="true">
            <circle cx="60" cy="60" r={RING_R} className={styles.track} />
            <circle cx="60" cy="60" r={RING_R} className={styles.arc} strokeDasharray={`${dash} ${RING_C}`} transform="rotate(-90 60 60)" />
          </svg>
          <div className={styles.ringText}>
            <span className={styles.left} data-testid="focus-left">
              {left >= 3600000 ? formatLength(left) : formatMmSs(left / 1000)}
            </span>
            <span className={styles.until}>until {formatClock(session.endsAt)}</span>
          </div>
        </div>
        <div className={styles.info}>
          <div className={styles.profile}>{session.profile.name}</div>
          <div className={styles.badges}>
            <Badge tone="accent">{strengthLabel(session.strength)}</Badge>
            {session.dryRun && <Badge tone="warn">Dry run</Badge>}
            {session.runId !== "" && <Badge>From a pipeline</Badge>}
          </div>
          <div className={styles.controls}>
            <Button size="sm" onClick={() => extend(15)} data-tip="Add 15 minutes">
              +15 min
            </Button>
            <Button size="sm" onClick={() => extend(30)} data-tip="Add 30 minutes">
              +30 min
            </Button>
            {strict ? (
              <Button size="sm" variant="danger" icon="lock-keyhole" onClick={() => void requestWeaken(FocusWeaken.WeakenEmergency)} data-tip="Type a phrase, then wait 5 minutes. The session keeps enforcing meanwhile">
                Emergency unlock
              </Button>
            ) : (
              <>
                <Button size="sm" variant="danger" onClick={() => void requestWeaken(FocusWeaken.WeakenEnd)} data-tip="Stop the session before its time">
                  End early
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void requestWeaken(FocusWeaken.WeakenEmergency)} data-tip="Type a phrase, then wait 5 minutes">
                  Emergency unlock
                </Button>
              </>
            )}
          </div>
          {friction && frictionHidden && (
            <p className={styles.pending} data-testid="friction-pending">
              {pendingLabel(friction.action)}
              {secondsUntil(friction.readyAt, t) > 0 ? ` in ${formatMmSs(secondsUntil(friction.readyAt, t))}` : " is ready"} ·{" "}
              <button type="button" className={styles.link} onClick={() => useFocus.getState().setFrictionHidden(false)}>
                Show
              </button>
            </p>
          )}
          {mac && <p className={styles.mac}>{MAC_LINE}</p>}
        </div>
      </div>

      {stillOpen.length > 0 && (
        <Section label="Still open" tip="Blocked programs that were already open when the session started and haven't closed">
          <ul className={styles.rows}>
            {stillOpen.map((a) => (
              <li key={`${a.pid}:${a.created}`} className={styles.row}>
                <AppIcon path={a.path} label={a.name} />
                <span className={styles.name}>{a.name}</span>
                <span className={styles.actions} data-always="">
                  <Button size="sm" variant="ghost" onClick={() => void FocusService.CloseAgain(a.pid, a.created).catch(report)} data-tip="Ask it to close again">
                    Close again
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void FocusService.ForceClose(a.pid, a.created).catch(report)} data-tip="End it without asking. Unsaved work is lost">
                    Force close
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void FocusService.LeaveOpen(a.pid, a.created).catch(report)} data-tip="Let it stay open this session">
                    Leave it
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section label="Blocked recently">
        {blocked.length === 0 ? (
          <p className={styles.empty}>Nothing has been stopped yet.</p>
        ) : (
          <ul className={styles.rows}>
            {blocked.map((b) => (
              <li key={b.path} className={styles.row} data-failed={b.result === "failed" ? "" : undefined}>
                <AppIcon path={b.path} label={b.name} />
                <span className={styles.name}>{b.name}</span>
                <span className={cx(styles.meta, b.result === "failed" && styles.fail)}>
                  {b.result === "failed" ? (b.error || blockedResultLabel(b.result)) : `${blockedResultLabel(b.result)} ×${b.count}`}
                </span>
                <span className={styles.meta}>{formatWhen(b.last, now())}</span>
                {!strict && (
                  <span className={styles.actions}>
                    <Button size="sm" variant="ghost" onClick={() => void allow(b)} data-tip="Allow it until this session ends. This takes the same effort as ending early">
                      Allow for this session
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
