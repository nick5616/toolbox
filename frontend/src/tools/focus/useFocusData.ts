import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components";
import { FocusStrength, FocusService, type FocusAllowRule, type FocusBlockedApp, type FocusLearnEntry, type FocusProfile, type FocusSession, type FocusSettings } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isActive, useFocus } from "@/state/focus";

export const DEFAULT_SETTINGS: FocusSettings = {
  alwaysAllowed: [],
  defaultStrength: FocusStrength.StrengthFirm,
  onStart: "close",
  pollMs: 1000,
  learn: false,
  learnSince: 0,
  lastProfileId: "",
  lastMinutes: 50,
};

export function report(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

function fixProfile(p: FocusProfile): FocusProfile {
  return { ...p, rules: p.rules ?? [] };
}

function fixSettings(s: FocusSettings): FocusSettings {
  return { ...s, alwaysAllowed: s.alwaysAllowed ?? [] };
}

export interface FocusData {
  loaded: boolean;
  profiles: FocusProfile[];
  settings: FocusSettings;
  recent: FocusSession[];
  extras: string[];
  /** The running session's stopped programs (or the last ended session's). */
  blocked: FocusBlockedApp[];
  learnList: FocusLearnEntry[];
  refresh: () => Promise<void>;
  saveProfile: (p: FocusProfile) => Promise<FocusProfile | null>;
  deleteProfile: (id: string) => Promise<void>;
  saveSettings: (s: FocusSettings) => Promise<void>;
  setLearn: (on: boolean) => Promise<void>;
  ignoreLearn: (path: string) => Promise<void>;
}

/** Loads the Focus tool's data from the service and keeps it fresh as the engine's state changes. */
export function useFocusData(): FocusData {
  const state = useFocus((s) => s.state);
  const blockedEvents = useFocus((s) => s.blocked.length);
  const [loaded, setLoaded] = useState(false);
  const [profiles, setProfiles] = useState<FocusProfile[]>([]);
  const [settings, setSettings] = useState<FocusSettings>(DEFAULT_SETTINGS);
  const [recent, setRecent] = useState<FocusSession[]>([]);
  const [extras, setExtras] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<FocusBlockedApp[]>([]);
  const [learnList, setLearnList] = useState<FocusLearnEntry[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, s, r] = await Promise.all([FocusService.Profiles(), FocusService.Settings(), FocusService.Recent(10)]);
      if (!alive.current) return;
      setProfiles((p ?? []).map(fixProfile));
      setSettings(fixSettings(s));
      setRecent(r ?? []);
      setLoaded(true);
    } catch (e) {
      if (alive.current) setLoaded(true);
      report(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    FocusService.WindowsExtras()
      .then((x) => alive.current && setExtras(x ?? []))
      .catch(() => undefined);
  }, [refresh]);

  // The session starting, ending or learn mode flipping changes what the lists show.
  const sessionKey = `${state.session?.id ?? ""}:${state.session?.endedAt ?? 0}:${state.last?.id ?? ""}:${state.learn ? 1 : 0}`;
  useEffect(() => {
    void refresh();
  }, [sessionKey, refresh]);

  const showBlocked = isActive(state) || state.last != null;
  useEffect(() => {
    if (!showBlocked) {
      setBlocked([]);
      return;
    }
    FocusService.Blocked(50)
      .then((b) => alive.current && setBlocked(b ?? []))
      .catch(() => undefined);
  }, [showBlocked, sessionKey, blockedEvents]);

  useEffect(() => {
    if (!state.learn) {
      setLearnList([]);
      return;
    }
    FocusService.LearnList()
      .then((l) => alive.current && setLearnList(l ?? []))
      .catch(() => undefined);
  }, [state.learn, blockedEvents, sessionKey]);

  const saveProfile = useCallback(async (p: FocusProfile) => {
    try {
      const saved = fixProfile(await FocusService.SaveProfile(p));
      if (alive.current) setProfiles((cur) => (cur.some((x) => x.id === saved.id) ? cur.map((x) => (x.id === saved.id ? saved : x)) : [...cur, saved]));
      return saved;
    } catch (e) {
      report(e);
      void refresh();
      return null;
    }
  }, [refresh]);

  const deleteProfile = useCallback(async (id: string) => {
    try {
      await FocusService.DeleteProfile(id);
      if (alive.current) setProfiles((cur) => cur.filter((x) => x.id !== id));
    } catch (e) {
      report(e);
    }
  }, []);

  const saveSettings = useCallback(async (s: FocusSettings) => {
    try {
      const saved = fixSettings(await FocusService.SaveSettings(s));
      if (alive.current) setSettings(saved);
    } catch (e) {
      report(e);
      void refresh();
    }
  }, [refresh]);

  const setLearn = useCallback(async (on: boolean) => {
    try {
      await FocusService.SetLearn(on);
      await refresh();
    } catch (e) {
      report(e);
    }
  }, [refresh]);

  const ignoreLearn = useCallback(async (path: string) => {
    try {
      await FocusService.IgnoreLearn(path);
      if (alive.current) setLearnList((cur) => cur.filter((x) => x.path !== path));
    } catch (e) {
      report(e);
    }
  }, []);

  return { loaded, profiles, settings, recent, extras, blocked, learnList, refresh, saveProfile, deleteProfile, saveSettings, setLearn, ignoreLearn };
}

/** Rules as saved: nothing but the fields the backend knows. */
export function cleanRules(rules: readonly FocusAllowRule[]): FocusAllowRule[] {
  return rules.map((r) => ({ id: r.id, label: r.label, kind: r.kind, path: r.path, children: r.children }));
}
