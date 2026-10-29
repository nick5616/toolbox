import { useState } from "react";
import { Banner, Button, DropZone, Icon, Section, SegmentedControl, Select, Spinner, Stepper, Switch } from "@/components";
import type { MediaSourceState } from "@/components/media";
import { formatMs } from "@/components/media";
import type { Language } from "@/lib/api";
import { basename } from "./logic";
import { MODEL_CHOICES, type Prefs } from "./options";
import { RunStatus } from "./RunStatus";
import type { JobRun } from "./useJobRun";
import styles from "./SubtitlesView.module.css";

export interface SourceStepProps {
  mediaPath: string | null;
  subPath: string | null;
  media: MediaSourceState;
  cueCount: number;
  prefs: Prefs;
  setPrefs: (next: Prefs | ((p: Prefs) => Prefs)) => void;
  languages: Language[];
  gen: JobRun;
  extract: JobRun;
  loadError: string | null;
  onPickMedia: () => void;
  onPickSubtitleFile: () => void;
  onGenerate: () => void;
  onExtract: (streamIndex: number) => void;
  onContinue: () => void;
  onStartOver: () => void;
}

/** Step 1: where the subtitles come from. */
export function SourceStep(p: SourceStepProps) {
  const [more, setMore] = useState(false);
  const { prefs, setPrefs } = p;
  const info = p.media.source?.info;
  const textStreams = (info?.subtitles ?? []).filter((s) => s.text);
  const otherStreams = (info?.subtitles ?? []).filter((s) => !s.text);
  const busy = p.gen.busy || p.extract.busy;
  const languageOptions = [{ value: "", label: "Auto-detect" }, ...p.languages.map((l) => ({ value: l.code, label: l.name }))];

  if (!p.mediaPath && p.cueCount === 0) {
    return (
      <div className={styles.sourceEmpty}>
        <DropZone
          id="tool-drop:subtitles"
          icon="captions"
          label="Drop a video, an audio file, or an .srt / .vtt"
          hint="Generate subtitles from speech, or edit ones you already have."
        >
          <div className={styles.buttonRow}>
            <Button icon="plus" onClick={p.onPickMedia}>
              Choose a video or audio file…
            </Button>
            <Button variant="secondary" icon="file-text" onClick={p.onPickSubtitleFile}>
              Use a subtitle file…
            </Button>
          </div>
        </DropZone>
      </div>
    );
  }

  return (
    <div className={styles.sourceBody}>
      {p.mediaPath && (
        <div className={styles.fileCard}>
          <Icon name={info && !info.video ? "music" : "film"} size={18} />
          <div className={styles.fileInfo}>
            <div className={styles.fileName} title={p.mediaPath}>
              {basename(p.mediaPath)}
            </div>
            <div className={styles.fileMeta}>
              {p.media.status === "loading" && (
                <>
                  <Spinner size={12} /> Reading the file…
                </>
              )}
              {p.media.status === "preparing" && "Preparing a preview copy…"}
              {p.media.status === "error" && (p.media.error?.message ?? "Couldn't read this file")}
              {info && `${formatMs(info.durationMs)} · ${info.video ? "video" : "audio"}`}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={p.onPickMedia} disabled={busy}>
            Change
          </Button>
        </div>
      )}

      {p.media.status === "error" && p.mediaPath && (
        <Banner tone="danger" title={p.media.error?.message ?? "Couldn't open this file"} action={<Button size="sm" onClick={p.media.retry}>Try again</Button>}>
          {p.media.error?.hint}
        </Banner>
      )}

      {p.loadError && (
        <Banner tone="danger" title="Couldn't read the subtitles">
          {p.loadError}
        </Banner>
      )}

      {p.cueCount > 0 && (
        <div className={styles.fileCard}>
          <Icon name="captions" size={18} />
          <div className={styles.fileInfo}>
            <div className={styles.fileName}>{p.cueCount} subtitles loaded</div>
            <div className={styles.fileMeta}>{p.subPath ? basename(p.subPath) : "Ready to edit"}</div>
          </div>
          {!p.mediaPath && (
            <Button size="sm" variant="secondary" icon="film" onClick={p.onPickMedia}>
              Pick the video (optional)
            </Button>
          )}
          <Button size="sm" onClick={p.onContinue}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={p.onStartOver}>
            Start over
          </Button>
        </div>
      )}

      {p.mediaPath && (
        <>
          <Section label="Generate from speech">
            <div className={styles.form}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Model</span>
                <Select
                  aria-label="Model"
                  value={prefs.model}
                  options={MODEL_CHOICES}
                  onChange={(model) => setPrefs((o) => ({ ...o, model }))}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Spoken language</span>
                <Select
                  aria-label="Spoken language"
                  value={prefs.language}
                  options={languageOptions}
                  onChange={(language) => setPrefs((o) => ({ ...o, language }))}
                />
              </label>
              <Switch
                checked={prefs.translateToEnglish}
                onChange={(translateToEnglish) => setPrefs((o) => ({ ...o, translateToEnglish }))}
                label="Translate to English"
              />
              <div>
                <Button size="sm" variant="ghost" icon={more ? "chevron-up" : "chevron-down"} aria-expanded={more} onClick={() => setMore((m) => !m)}>
                  More
                </Button>
              </div>
              {more && (
                <div className={styles.moreBox}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Characters per line</span>
                    <Stepper
                      aria-label="Characters per line"
                      value={prefs.maxLineChars}
                      min={32}
                      max={60}
                      onChange={(maxLineChars) => setPrefs((o) => ({ ...o, maxLineChars }))}
                    />
                  </label>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Lines</span>
                    <SegmentedControl
                      aria-label="Lines per subtitle"
                      value={String(prefs.maxLines)}
                      options={[
                        { value: "1", label: "1" },
                        { value: "2", label: "2" },
                      ]}
                      onChange={(v) => setPrefs((o) => ({ ...o, maxLines: Number(v) }))}
                    />
                  </div>
                </div>
              )}
              <div>
                <Button icon="captions" onClick={p.onGenerate} loading={p.gen.busy} disabled={busy || p.media.status === "error"}>
                  Generate subtitles
                </Button>
              </div>
              <RunStatus run={p.gen} runningLabel="Listening for speech…" showResult={false} />
            </div>
          </Section>

          <Section label="Subtitles inside this video">
            {p.media.status === "loading" ? (
              <div className={styles.muted}>Reading the file…</div>
            ) : textStreams.length === 0 && otherStreams.length === 0 ? (
              <div className={styles.muted}>This file has no subtitle tracks.</div>
            ) : (
              <ul className={styles.streams}>
                {textStreams.map((s) => (
                  <li key={s.index} className={styles.stream}>
                    <span className={styles.streamName}>
                      {s.title || `Track ${s.index}`}
                      <span className={styles.muted}> · {s.language || "unknown language"} · {s.codec}</span>
                    </span>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => p.onExtract(s.index)}>
                      Use this track
                    </Button>
                  </li>
                ))}
                {otherStreams.map((s) => (
                  <li key={s.index} className={styles.stream}>
                    <span className={styles.streamName}>
                      {s.title || `Track ${s.index}`}
                      <span className={styles.muted}> · {s.language || "unknown language"} · {s.codec}</span>
                    </span>
                    <span className={styles.muted}>Picture-based, can't be edited</span>
                  </li>
                ))}
              </ul>
            )}
            <RunStatus run={p.extract} runningLabel="Extracting subtitles…" showResult={false} />
          </Section>
        </>
      )}

      <Section label="Subtitle file">
        <div className={styles.buttonRow}>
          <Button variant="secondary" icon="file-text" onClick={p.onPickSubtitleFile} disabled={busy}>
            Use a subtitle file…
          </Button>
          <span className={styles.muted}>An .srt or .vtt you already have.</span>
        </div>
      </Section>
    </div>
  );
}
