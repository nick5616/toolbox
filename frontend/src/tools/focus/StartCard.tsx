import { useMemo, useState } from "react";
import { AppPicker } from "@/blocks/app-picker";
import { Button, Icon, IconButton, SegmentedControl, TextField, toast } from "@/components";
import { FocusService, FocusStrength, type FocusAllowRule, type FocusProfile, type FocusSettings } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { MAX_EXTRA_RULES, MAX_SESSION_MINUTES, PRESET_MINUTES, STRENGTH_OPTIONS, mergeRules, nextClockTime, rulePaths, strengthExplanation, untilProblem } from "./model";
import styles from "./StartCard.module.css";

export interface StartCardProps {
  profiles: readonly FocusProfile[];
  settings: FocusSettings;
  selectedId: string;
  onSelect: (id: string) => void;
  supported: boolean;
  unsupported: string;
  dryRun: boolean;
  now?: () => number;
}

type Length = number | "until";

function presetLabel(m: number): string {
  return m >= 120 && m % 60 === 0 ? `${m / 60} h` : `${m} min`;
}

/** Idle: pick a profile, a length and a strength, then Start (SPEC §5.1). */
export function StartCard({ profiles, settings, selectedId, onSelect, supported, unsupported, dryRun, now = Date.now }: StartCardProps) {
  const initialMinutes = settings.lastMinutes > 0 ? settings.lastMinutes : 50;
  const isPreset = (PRESET_MINUTES as readonly number[]).includes(initialMinutes);
  const [length, setLength] = useState<Length>(isPreset ? initialMinutes : 50);
  const [customMinutes, setCustomMinutes] = useState(isPreset || initialMinutes > MAX_SESSION_MINUTES ? "" : String(initialMinutes));
  const [untilText, setUntilText] = useState("");
  const [strength, setStrength] = useState<FocusStrength>(settings.defaultStrength || FocusStrength.StrengthFirm);
  const [extra, setExtra] = useState<FocusAllowRule[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const profile = profiles.find((p) => p.id === selectedId) ?? null;
  const typedMinutes = customMinutes.trim() === "" ? null : Number(customMinutes);

  const { minutes, until, problem } = useMemo(() => {
    if (length === "until") {
      const t = nextClockTime(untilText, now());
      return { minutes: 0, until: t ?? 0, problem: untilProblem(t, now()) };
    }
    if (typedMinutes != null) {
      const ok = Number.isInteger(typedMinutes) && typedMinutes >= 1 && typedMinutes <= MAX_SESSION_MINUTES;
      return { minutes: ok ? typedMinutes : 0, until: 0, problem: ok ? "" : `Enter 1 to ${MAX_SESSION_MINUTES} minutes` };
    }
    return { minutes: length, until: 0, problem: "" };
  }, [length, untilText, typedMinutes, now]);

  const blocker = !supported ? unsupported || "Focus Lock works on Windows and macOS" : !profile ? "Pick a profile first" : problem;

  const start = async () => {
    if (blocker || !profile) return;
    setBusy(true);
    try {
      await FocusService.Start({ profileId: profile.id, minutes, until, strength, extra, onStart: "", runId: "", stepId: "" });
    } catch (e) {
      const err = toAppError(e);
      toast({ tone: "danger", title: err.message, description: err.hint });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.group}>
        <span className={styles.label}>Allow</span>
        <div className={styles.chips} role="radiogroup" aria-label="Profile">
          {profiles.length === 0 && <span className={styles.hint}>Make a profile below first.</span>}
          {profiles.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={p.id === selectedId} className={styles.chip} data-on={p.id === selectedId ? "" : undefined} onClick={() => onSelect(p.id)}>
              {p.name}
              {p.id === settings.lastProfileId && <span className={styles.last}>last used</span>}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.label}>For</span>
        <div className={styles.chips} role="radiogroup" aria-label="Length">
          {PRESET_MINUTES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={length === m && typedMinutes == null}
              className={styles.chip}
              data-on={length === m && typedMinutes == null ? "" : undefined}
              onClick={() => {
                setLength(m);
                setCustomMinutes("");
              }}
            >
              {presetLabel(m)}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={length === "until"} className={styles.chip} data-on={length === "until" ? "" : undefined} onClick={() => setLength("until")}>
            Until…
          </button>
          {length === "until" ? (
            <TextField
              size="sm"
              mono
              wrapperClassName={styles.time}
              aria-label="Until (24 hour time)"
              placeholder="17:30"
              value={untilText}
              onChange={(e) => setUntilText(e.target.value)}
              invalid={untilText !== "" && problem !== ""}
            />
          ) : (
            <TextField
              size="sm"
              mono
              wrapperClassName={styles.time}
              aria-label="Custom minutes"
              placeholder="min"
              inputMode="numeric"
              value={customMinutes}
              onChange={(e) => setCustomMinutes(e.target.value.replace(/[^\d]/g, ""))}
              invalid={customMinutes !== "" && problem !== ""}
            />
          )}
        </div>
        {length === "until" && untilText !== "" && problem !== "" && <span className={styles.problem}>{problem}</span>}
      </div>

      <div className={styles.group}>
        <span className={styles.label}>Lock</span>
        <SegmentedControl aria-label="Strength" size="sm" value={strength} options={STRENGTH_OPTIONS} onChange={setStrength} />
        <span className={styles.hint}>{strengthExplanation(strength)}</span>
      </div>

      <div className={styles.group}>
        <span className={styles.label}>Also allow for this session</span>
        <div className={styles.chips}>
          {extra.map((r, i) => (
            <span key={`${r.kind}|${r.path}`} className={styles.appChip}>
              {r.label}
              <IconButton size="sm" icon="x" label={`Remove ${r.label}`} onClick={() => setExtra((cur) => cur.filter((_, j) => j !== i))} />
            </span>
          ))}
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            disabled={extra.length >= MAX_EXTRA_RULES}
            data-tip={extra.length >= MAX_EXTRA_RULES ? `At most ${MAX_EXTRA_RULES} extra apps` : "Allow another app, only for this session"}
            onClick={() => setPicking(true)}
          >
            Add app
          </Button>
        </div>
      </div>

      <div className={styles.actions}>
        {dryRun && (
          <span className={styles.dry} data-tip="Dry run: Toolbox decides and logs but never stops anything">
            <Icon name="info" size={14} /> Dry run
          </span>
        )}
        <span className={styles.spacer} />
        <Button variant="primary" icon="play" loading={busy} disabled={blocker !== ""} data-tip={blocker || "Start the focus session"} onClick={() => void start()}>
          Start
        </Button>
      </div>

      <AppPicker
        open={picking}
        onClose={() => setPicking(false)}
        mode="rule"
        multiple
        chosen={rulePaths(extra)}
        title="Also allow for this session"
        onPickRules={(rules) => setExtra((cur) => mergeRules(cur, rules).slice(0, MAX_EXTRA_RULES))}
      />
    </div>
  );
}
