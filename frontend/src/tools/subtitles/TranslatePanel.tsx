import { useEffect, useMemo } from "react";
import { Banner, Button, Section, Select, Spinner } from "@/components";
import { documentIssues } from "./logic";
import { RunStatus } from "./RunStatus";
import { useRun } from "./runs";
import { useSubtitles } from "./store";
import styles from "./SubtitlesView.module.css";

/** Translate panel: translate the original track with the local chat model into a new track. */
export function TranslatePanel() {
  const languages = useSubtitles((s) => s.languages);
  const status = useSubtitles((s) => s.translator);
  const original = useSubtitles((s) => s.editor.tabs[0]);
  const sourceLang = useSubtitles((s) => s.sourceLang);
  const targetLanguage = useSubtitles((s) => s.prefs.targetLanguage);
  const maxLine = useSubtitles((s) => s.prefs.maxLineChars);
  const patchPrefs = useSubtitles((s) => s.patchPrefs);
  const setSourceLang = useSubtitles((s) => s.setSourceLang);
  const refresh = useSubtitles((s) => s.refreshTranslator);
  const translate = useSubtitles((s) => s.translate);
  const openChat = useSubtitles((s) => s.openChat);
  const run = useRun("translate");

  useEffect(() => {
    refresh();
  }, [refresh]);

  const cueCount = original?.history.present.length ?? 0;
  const blocker = useMemo(() => (original ? documentIssues(original.history.present, maxLine).firstError : null), [original, maxLine]);
  const sourceLanguage = sourceLang ?? original?.language ?? "";
  const sourceOptions = [{ value: "", label: "Unknown" }, ...languages.map((l) => ({ value: l.code, label: l.name }))];
  const targetOptions = [
    { value: "", label: "Choose a language…" },
    ...languages.filter((l) => l.code !== sourceLanguage).map((l) => ({ value: l.code, label: l.name })),
  ];
  const ready = status?.ready === true;

  return (
    <div className={styles.panel}>
      <Section
        label="Translate"
        tip="Translate the subtitles with your local chat model; nothing leaves your computer"
        action={
          <Button size="sm" variant="ghost" icon="refresh-cw" onClick={refresh} data-tip="Check again whether Local Chat has a model ready">
            Check again
          </Button>
        }
      >
        <div className={styles.form}>
          {status === null ? (
            <div className={styles.muted}>
              <Spinner size={12} label="Checking Local Chat" /> Checking Local Chat…
            </div>
          ) : ready ? (
            <div className={styles.muted}>Translating with {status.model || "the Local Chat model"}.</div>
          ) : (
            <Banner
              tone="warn"
              title="Download a model in Local Chat to translate"
              action={
                <Button size="sm" onClick={openChat} data-tip="Go to Local Chat to download a model">
                  Open Local Chat
                </Button>
              }
            >
              {status.error}
            </Banner>
          )}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>From</span>
            <Select aria-label="Source language" data-tip="The language of the current subtitles; Unknown lets the model work it out" value={sourceLanguage} options={sourceOptions} onChange={setSourceLang} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>To</span>
            <Select aria-label="Target language" data-tip="The language to translate into; the result becomes a new track" value={targetLanguage} options={targetOptions} onChange={(code) => patchPrefs({ targetLanguage: code })} />
          </label>
          {blocker && (
            <Banner tone="warn" title="Fix this before translating">
              {blocker}
            </Banner>
          )}
          <div>
            <Button
              icon="languages"
              loading={run.busy}
              disabled={!ready || targetLanguage === "" || cueCount === 0 || blocker !== null || run.busy}
              data-tip={!ready ? "Local Chat needs a downloaded model first" : targetLanguage === "" ? "Choose the language to translate into" : cueCount === 0 ? "There are no subtitles to translate" : blocker ?? (run.busy ? "Translation is already running" : "Translate every subtitle with the local chat model")}
              onClick={translate}
            >
              Translate {cueCount} {cueCount === 1 ? "subtitle" : "subtitles"}
            </Button>
          </div>
          <RunStatus run={run} runningLabel="Translating…" doneLabel="Translated" onOpenChat={openChat} />
        </div>
      </Section>
    </div>
  );
}
