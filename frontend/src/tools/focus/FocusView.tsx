import { useEffect, useMemo, useState } from "react";
import { Badge, Banner, ToolHeader } from "@/components";
import { FocusService, FocusStrength } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { isActive, subscribeFocus, useFocus } from "@/state/focus";
import type { ToolViewProps } from "@/tools";
import { ActivePanel } from "./ActivePanel";
import { FrictionDialog } from "./FrictionDialog";
import { AlwaysAllowed, DryRunBanner, LearnPanel, RecentList } from "./IdlePanels";
import { endedSummary, formatClock, formatLength, UNSUPPORTED_LINE } from "./model";
import { ProfilesPanel } from "./ProfilesPanel";
import { StartCard } from "./StartCard";
import { report, useFocusData } from "./useFocusData";
import styles from "./FocusView.module.css";

/** Focus Lock (Phase 18, SPEC §5.1): idle, active and ended states of a form tool. */
export default function FocusView({ moduleId }: ToolViewProps) {
  const state = useFocus((s) => s.state);
  const loaded = useFocus((s) => s.loaded);
  const data = useFocusData();
  const [chosenId, setChosenId] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => subscribeFocus(), []);

  const active = isActive(state);
  const session = active ? state.session : null;
  const mac = state.os === "darwin";

  // The selected profile: the last used one, else the first; it follows deletes.
  const selectedId = useMemo(() => {
    if (data.profiles.some((p) => p.id === chosenId)) return chosenId;
    if (data.profiles.some((p) => p.id === data.settings.lastProfileId)) return data.settings.lastProfileId;
    return data.profiles[0]?.id ?? "";
  }, [chosenId, data.profiles, data.settings.lastProfileId]);
  const selected = data.profiles.find((p) => p.id === selectedId) ?? null;

  useCommands([
    {
      id: "focus.startLast",
      title: "Start focus with the last profile",
      section: "Actions",
      icon: "focus",
      keywords: ["focus", "lock", "session"],
      enabled: () => state.supported && !isActive(useFocus.getState().state),
      run: () => {
        const p = data.profiles.find((x) => x.id === data.settings.lastProfileId) ?? data.profiles[0];
        if (!p) return;
        void FocusService.Start({
          profileId: p.id,
          minutes: data.settings.lastMinutes || 50,
          until: 0,
          strength: data.settings.defaultStrength || FocusStrength.StrengthFirm,
          extra: [],
          onStart: "",
          runId: "",
          stepId: "",
        }).catch(report);
      },
    },
    {
      id: "focus.extend15",
      title: "Extend focus by 15 minutes",
      section: "Actions",
      icon: "timer",
      enabled: () => isActive(useFocus.getState().state),
      run: () => void FocusService.Extend(15).catch(report),
    },
  ]);

  const friction = state.friction;
  const confirm = async (phrase: string) => {
    if (!friction) return;
    setConfirming(true);
    try {
      await FocusService.ConfirmWeaken(friction.action, phrase);
      const st = useFocus.getState();
      st.setState({ ...st.state, friction: null });
    } catch (e) {
      report(e);
    } finally {
      setConfirming(false);
    }
  };
  const cancel = () => {
    const st = useFocus.getState();
    st.setState({ ...st.state, friction: null });
    void FocusService.CancelWeaken().catch(report);
  };

  const status = session ? `Focusing until ${formatClock(session.endsAt)}` : state.learn ? "Learning" : "Not focusing";

  return (
    <div className={styles.root} data-module={moduleId} data-state={active ? "active" : "idle"}>
      <ToolHeader aria-label="Focus Lock">
        <span className={styles.status} data-testid="focus-status">
          {status}
        </span>
        {session && <Badge tone="accent">{formatLength(Math.max(0, session.endsAt - Date.now()))} left</Badge>}
        {!session && state.dryRun && <Badge tone="warn">Dry run</Badge>}
      </ToolHeader>

      <div className={styles.page}>
        {!state.supported && (
          <Banner tone="info" title={UNSUPPORTED_LINE}>
            {state.unsupported && state.unsupported !== UNSUPPORTED_LINE ? state.unsupported : "You can still make profiles here."}
          </Banner>
        )}
        {state.dryRun && (active || state.learn) && <DryRunBanner />}

        {active && session ? (
          <ActivePanel session={session} blocked={data.blocked} stillOpen={state.stillOpen ?? []} mac={mac} />
        ) : (
          <>
            {state.last && state.last.endedAt > 0 && (
              <p className={styles.ended} data-testid="focus-ended">
                {endedSummary(state.last, data.blocked)}
              </p>
            )}
            {state.supported && data.loaded && (
              <StartCard
                key={data.settings.lastProfileId + ":" + data.settings.lastMinutes}
                profiles={data.profiles}
                settings={data.settings}
                selectedId={selectedId}
                onSelect={setChosenId}
                supported={state.supported}
                unsupported={state.unsupported}
                dryRun={state.dryRun}
              />
            )}
          </>
        )}

        {!active && (
          <>
            <ProfilesPanel
              profiles={data.profiles}
              loaded={data.loaded && loaded}
              selectedId={selectedId}
              onSelect={setChosenId}
              onSave={data.saveProfile}
              onDelete={data.deleteProfile}
              supported={state.supported}
            />
            <AlwaysAllowed settings={data.settings} extras={data.extras} onSave={data.saveSettings} />
            <LearnPanel
              learn={state.learn}
              dryRun={state.dryRun}
              settings={data.settings}
              entries={data.learnList}
              profile={selected}
              onToggle={(on) => void data.setLearn(on)}
              onIgnore={data.ignoreLearn}
              onSaveSettings={data.saveSettings}
              onSaveProfile={data.saveProfile}
            />
            <RecentList sessions={data.recent} />
          </>
        )}
      </div>

      {friction && <FrictionDialog friction={friction} busy={confirming} onConfirm={(p) => void confirm(p)} onCancel={cancel} />}
    </div>
  );
}
