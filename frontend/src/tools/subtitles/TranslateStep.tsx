import { Banner, Button, Section, Select, Spinner } from "@/components";
import type { SubtitleLanguage, TranslatorStatus } from "@/lib/api";
import { RunStatus } from "./RunStatus";
import type { JobRun } from "./useJobRun";
import styles from "./SubtitlesView.module.css";

export interface TranslateStepProps {
  languages: SubtitleLanguage[];
  /** null while the status is loading. */
  status: TranslatorStatus | null;
  cueCount: number;
  blocker: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  run: JobRun;
  onSource: (code: string) => void;
  onTarget: (code: string) => void;
  onTranslate: () => void;
  onRefreshStatus: () => void;
  onOpenChat: () => void;
}

/** Step 3: translate the original track with the local chat model. */
export function TranslateStep(p: TranslateStepProps) {
  const sourceOptions = [{ value: "", label: "Unknown" }, ...p.languages.map((l) => ({ value: l.code, label: l.name }))];
  const targetOptions = [
    { value: "", label: "Choose a language…" },
    ...p.languages.filter((l) => l.code !== p.sourceLanguage).map((l) => ({ value: l.code, label: l.name })),
  ];
  const ready = p.status?.ready === true;

  return (
    <div className={styles.sourceBody}>
      <Section
        label="Translate"
        action={
          <Button size="sm" variant="ghost" icon="refresh-cw" onClick={p.onRefreshStatus}>
            Check again
          </Button>
        }
      >
        <div className={styles.form}>
          {p.status === null ? (
            <div className={styles.muted}>
              <Spinner size={12} label="Checking Local Chat" /> Checking Local Chat…
            </div>
          ) : ready ? (
            <div className={styles.muted}>Translating with {p.status.model || "the Local Chat model"}.</div>
          ) : (
            <Banner
              tone="warn"
              title="Download a model in Local Chat to translate"
              action={
                <Button size="sm" onClick={p.onOpenChat}>
                  Open Local Chat
                </Button>
              }
            >
              {p.status.error}
            </Banner>
          )}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>From</span>
            <Select aria-label="Source language" value={p.sourceLanguage} options={sourceOptions} onChange={p.onSource} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>To</span>
            <Select aria-label="Target language" value={p.targetLanguage} options={targetOptions} onChange={p.onTarget} />
          </label>
          {p.blocker && (
            <Banner tone="warn" title="Fix this before translating">
              {p.blocker}
            </Banner>
          )}
          <div className={styles.muted}>Local Chat translates in batches. Chatting there at the same time makes this wait for its turn.</div>
          <div>
            <Button
              icon="languages"
              loading={p.run.busy}
              disabled={!ready || p.targetLanguage === "" || p.cueCount === 0 || p.blocker !== null || p.run.busy}
              onClick={p.onTranslate}
            >
              Translate {p.cueCount} {p.cueCount === 1 ? "subtitle" : "subtitles"}
            </Button>
          </div>
          <RunStatus run={p.run} runningLabel="Translating…" doneLabel="Translated" onOpenChat={p.onOpenChat} />
        </div>
      </Section>
    </div>
  );
}
