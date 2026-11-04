/**
 * Song analysis for the open edit (SPEC §14.2, §11.5): offers an earlier
 * analysis of the same song, the words choice, and the analyze job with
 * progress, cancel and retry. When the job finishes the project's analysisKey
 * is set (useEditData then loads it).
 */
import { useEffect, useRef, useState } from "react";
import { Banner, Button, Meter, SegmentedControl, Select, TextArea, Tooltip } from "@/components";
import { EditStudioService, JobsService, JobStatus, TranscribeService, WordsSource, type AnalysisRef } from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { isActive, useJob, useJobs } from "@/state/jobs";
import { useEditStudio, useProject } from "../store";
import { flushEdit } from "../useEditAutosave";
import styles from "./Setup.module.css";

/** Go's viz.MaxLyricsChars. */
const MAX_LYRICS = 20_000;

type Words = "none" | "detect" | "align";
const WORDS: Array<{ value: Words; label: string; tip: string }> = [
  { value: "none", label: "None", tip: "Skip the words: the fastest option, and fine for edits without captions or lyrics" },
  { value: "detect", label: "Detect", tip: "Listen to the vocals and write out the words, for captions and word markers" },
  { value: "align", label: "Use my lyrics", tip: "Paste the real lyrics and match them to the singing for exact line and word timing" },
];
const SOURCE: Record<Words, WordsSource> = { none: WordsSource.WordsNone, detect: WordsSource.WordsDetect, align: WordsSource.WordsAlign };

/** The analysis ref of a finished job's result JSON, or null. */
export function analysisRefOf(resultJson: string): AnalysisRef | null {
  if (!resultJson) return null;
  try {
    const r = JSON.parse(resultJson) as { analysis?: AnalysisRef | null };
    return r.analysis && typeof r.analysis.key === "string" && r.analysis.key ? r.analysis : null;
  } catch {
    return null;
  }
}

export function AnalysisPanel() {
  const project = useProject();
  const projectId = useEditStudio((s) => s.projectId);
  const jobId = useEditStudio((s) => s.jobs.analyze);
  const job = useJob(jobId ?? "");
  const song = project?.song?.path ?? "";
  const [words, setWords] = useState<Words>("none");
  const [lyrics, setLyrics] = useState("");
  const [language, setLanguage] = useState("");
  const [languages, setLanguages] = useState<Array<{ code: string; name: string }>>([]);
  const [offer, setOffer] = useState<{ ref: AnalysisRef; hasWords: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AppErrorShape | null>(null);
  const handled = useRef("");

  // An earlier analysis of the same song.
  useEffect(() => {
    if (!song) return;
    let live = true;
    EditStudioService.AnalysisFor(song).then(
      ([ref, found]) => live && setOffer(found && ref.key ? { ref, hasWords: ref.summary.hasWords || !!ref.textJson } : null),
      () => live && setOffer(null),
    );
    return () => {
      live = false;
    };
  }, [song]);

  useEffect(() => {
    if (words === "none" || languages.length) return;
    let live = true;
    TranscribeService.Languages().then(
      (l) => live && setLanguages((l ?? []).map((x) => ({ code: x.code, name: x.name }))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [words, languages.length]);

  // A finished job sets the analysis key.
  useEffect(() => {
    if (!job || job.status !== JobStatus.JobDone || handled.current === job.id) return;
    handled.current = job.id;
    const ref = analysisRefOf(job.resultJson);
    const st = useEditStudio.getState();
    const p = st.history?.present;
    if (ref && p) {
      st.edit({ ...p, analysisKey: ref.key });
      st.setJob("analyze", undefined);
      st.setReanalyze(false);
    } else {
      setError({ code: "internal", message: "The analysis finished but didn't leave a result", hint: "Try analyzing again." });
    }
  }, [job]);

  if (!project?.song || !projectId) return null;

  const useOffer = () => {
    if (!offer) return;
    const st = useEditStudio.getState();
    const p = st.history?.present;
    if (p) st.edit({ ...p, analysisKey: offer.ref.key });
    st.setReanalyze(false);
  };

  const start = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await flushEdit();
      const j = await EditStudioService.Analyze(projectId, {
        song,
        words: SOURCE[words],
        lyricsText: words === "align" ? lyrics.trim() : "",
        language: words === "none" ? "" : language,
      });
      useJobs.getState().upsert(j);
      useEditStudio.getState().setJob("analyze", j.id);
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = () => {
    if (jobId) JobsService.Cancel(jobId).catch(() => undefined);
  };

  const active = !!job && isActive(job);
  const failed = job?.status === JobStatus.JobFailed;
  const cancelled = job?.status === JobStatus.JobCancelled;
  const lyricsBad = words === "align" && (lyrics.trim() === "" || lyrics.length > MAX_LYRICS);

  if (active && job) {
    return (
      <div className={styles.box} role="status" aria-live="polite">
        <div className={styles.head}>
          <span>{job.status === JobStatus.JobQueued ? "Waiting to start…" : "Analyzing the song…"}</span>
          <Button size="sm" variant="ghost" data-tip="Stop the analysis; you can start it again" onClick={cancel}>
            Cancel
          </Button>
        </div>
        <Tooltip label="How far the song analysis has got"><Meter value={job.status === JobStatus.JobQueued ? -1 : job.progress} status={job.status === JobStatus.JobQueued ? "queued" : "running"} label="Analysis progress" /></Tooltip>
        {job.message && <div className={styles.msg}>{job.message}</div>}
      </div>
    );
  }

  return (
    <div className={styles.group}>
      {offer && offer.ref.key !== project.analysisKey && (
        <Banner
          tone="info"
          title="This song was analysed before"
          action={
            <Button size="sm" variant="primary" data-tip="Reuse the earlier analysis of this song: no waiting" onClick={useOffer}>
              Use it
            </Button>
          }
        >
          {offer.hasWords ? "That analysis has the lyrics." : "That analysis has no lyrics."} Or analyze again below.
        </Banner>
      )}
      <div className={styles.group}>
        <span className={styles.label} id="es-words-label" data-tip="Whether to find the sung words, which captions and word markers need">
          Words
        </span>
        <SegmentedControl aria-labelledby="es-words-label" value={words} options={WORDS} onChange={setWords} />
        {words === "detect" && <span className={styles.hint}>Transcribes the vocals. Good for captions and the word markers.</span>}
        {words === "align" && (
          <>
            <TextArea aria-label="Your lyrics" data-tip={`Plain text, one lyric line per line, up to ${MAX_LYRICS.toLocaleString()} characters`} minRows={5} placeholder="Paste the lyrics, one line per line" value={lyrics} onChange={(e) => setLyrics(e.target.value)} />
            <span className={styles.count} data-tip="Characters used out of the allowed maximum">{`${lyrics.length.toLocaleString()} / ${MAX_LYRICS.toLocaleString()}`}</span>
          </>
        )}
        {words !== "none" && (
          <label className={styles.row}>
            <span className={styles.label}>Language</span>
            <Select
              aria-label="Language"
              data-tip="Language of the vocals; Auto lets the engine work it out"
              value={language}
              onChange={setLanguage}
              options={[{ value: "", label: "Auto" }, ...languages.map((l) => ({ value: l.code, label: l.name }))]}
            />
          </label>
        )}
      </div>
      {(failed || error || cancelled) && (
        <Banner
          tone={cancelled && !failed && !error ? "info" : "danger"}
          title={error?.message || (failed ? job?.error || "The analysis didn't work" : "Cancelled")}
          action={
            <Button size="sm" data-tip="Run the song analysis again" onClick={() => void start()}>
              {cancelled ? "Start again" : "Retry"}
            </Button>
          }
        >
          {error?.hint || (failed ? job?.errorHint : "")}
        </Banner>
      )}
      <div className={styles.row}>
        <Button variant="primary" icon="sparkles" loading={submitting} disabled={lyricsBad} data-tip={lyricsBad ? (lyrics.trim() === "" ? "Paste your lyrics first, or choose None or Detect" : "Your lyrics are over the maximum length") : "Find the beats, bars, sections and instruments in the song so clips can be cut to them"} onClick={() => void start()}>
          {offer ? "Analyze again" : "Analyze"}
        </Button>
        <span className={styles.hint}>Takes a minute or two. The result is kept for next time.</span>
      </div>
    </div>
  );
}
