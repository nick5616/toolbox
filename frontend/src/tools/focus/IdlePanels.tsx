import { useState } from "react";
import { AppIcon, AppPicker } from "@/blocks/app-picker";
import { Banner, Button, Section, Switch } from "@/components";
import { FocusService, type FocusAllowRule, type FocusLearnEntry, type FocusProfile, type FocusSession, type FocusSettings } from "@/lib/api";
import { endReasonLabel, formatLength, formatWhen, learnSummary, mergeRules, rulePaths } from "./model";
import { RulesList } from "./RulesList";
import { report } from "./useFocusData";
import styles from "./IdlePanels.module.css";

export interface AlwaysAllowedProps {
  settings: FocusSettings;
  extras: readonly string[];
  onSave: (s: FocusSettings) => Promise<void>;
}

/** The standing allow list, plus the read-only Windows extras (SPEC §1.3, §5.1). */
export function AlwaysAllowed({ settings, extras, onSave }: AlwaysAllowedProps) {
  const [picking, setPicking] = useState(false);
  const rules = settings.alwaysAllowed ?? [];
  const set = (alwaysAllowed: FocusAllowRule[]) => void onSave({ ...settings, alwaysAllowed });
  return (
    <Section
      label="Always allowed"
      tip="Allowed in every session, whatever the profile"
      action={
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setPicking(true)}>
          Add app
        </Button>
      }
    >
      <RulesList rules={rules} onChange={set} empty="Nothing yet. Add the apps every session needs." />
      <details className={styles.extras}>
        <summary>Windows extras ({extras.length})</summary>
        <p className={styles.note}>Parts of Windows that live outside its own folder. They are always allowed and can't be changed.</p>
        <ul className={styles.extraList}>
          {extras.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </details>
      <AppPicker open={picking} onClose={() => setPicking(false)} mode="rule" multiple chosen={rulePaths(rules)} title="Always allow" onPickRules={(added) => set(mergeRules(rules, added))} />
    </Section>
  );
}

export interface LearnPanelProps {
  learn: boolean;
  dryRun: boolean;
  settings: FocusSettings;
  entries: readonly FocusLearnEntry[];
  profile: FocusProfile | null;
  onToggle: (on: boolean) => void;
  onIgnore: (path: string) => Promise<void>;
  onSaveSettings: (s: FocusSettings) => Promise<void>;
  onSaveProfile: (p: FocusProfile) => Promise<FocusProfile | null>;
  now?: () => number;
}

/** Learn mode: a switch, the summary and the would-stop list with Always allow / Add to profile / Ignore (SPEC §2.6). */
export function LearnPanel({ learn, dryRun, settings, entries, profile, onToggle, onIgnore, onSaveSettings, onSaveProfile }: LearnPanelProps) {
  const ruleFor = async (path: string): Promise<FocusAllowRule | null> => {
    try {
      return (await FocusService.AppFor(path)).rule;
    } catch (e) {
      report(e);
      return null;
    }
  };

  const alwaysAllow = async (e: FocusLearnEntry) => {
    const rule = await ruleFor(e.path);
    if (!rule) return;
    await onSaveSettings({ ...settings, alwaysAllowed: mergeRules(settings.alwaysAllowed ?? [], [rule]) });
    await onIgnore(e.path);
  };

  const addToProfile = async (e: FocusLearnEntry) => {
    if (!profile) return;
    const rule = await ruleFor(e.path);
    if (!rule) return;
    const saved = await onSaveProfile({ ...profile, rules: mergeRules(profile.rules ?? [], [rule]) });
    if (saved) await onIgnore(e.path);
  };

  return (
    <Section label="Learn mode" tip="Watch what would have been stopped, without stopping anything">
      <Switch
        checked={learn}
        onChange={onToggle}
        label="Watch without stopping anything"
        tip="Runs in dry run against your last profile and Always allowed, and lists the programs that would have been stopped"
      />
      {learn && (
        <>
          {dryRun && <p className={styles.note}>Dry run: nothing is being stopped.</p>}
          <p className={styles.summary}>{learnSummary(settings.learnSince, entries.length)}</p>
          {entries.length > 0 && (
            <ul className={styles.learnList}>
              {entries.map((e) => (
                <li key={e.path} className={styles.learnRow}>
                  <AppIcon path={e.path} label={e.name} />
                  <span className={styles.name}>{e.name}</span>
                  <span className={styles.meta}>×{e.count}</span>
                  <span className={styles.actions}>
                    <Button size="sm" variant="ghost" onClick={() => void alwaysAllow(e)} data-tip="Allow it in every session">
                      Always allow
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!profile} data-tip={profile ? `Add it to ${profile.name}` : "Pick a profile first"} onClick={() => void addToProfile(e)}>
                      Add to profile
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void onIgnore(e.path)} data-tip="Forget these entries">
                      Ignore
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

export interface RecentListProps {
  sessions: readonly FocusSession[];
  now?: () => number;
}

/** The last ten sessions (SPEC §5.1). */
export function RecentList({ sessions, now = Date.now }: RecentListProps) {
  if (sessions.length === 0) return null;
  const t = now();
  return (
    <Section label="Recent sessions">
      <ul className={styles.recent}>
        {sessions.slice(0, 10).map((s) => (
          <li key={s.id} className={styles.recentRow}>
            <span className={styles.when}>{formatWhen(s.startedAt, t)}</span>
            <span className={styles.name}>{s.profile.name}</span>
            <span className={styles.meta}>{formatLength(Math.max(0, (s.endedAt || s.endsAt) - s.startedAt))}</span>
            <span className={styles.meta}>{endReasonLabel(s.endReason)}</span>
            <span className={styles.meta}>{s.blocked > 0 ? `${s.blocked} stopped` : "none stopped"}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function DryRunBanner() {
  return (
    <Banner tone="warn" title="Dry run: nothing is being stopped">
      Toolbox decides and logs what it would stop, but never closes or terminates anything here.
    </Banner>
  );
}
