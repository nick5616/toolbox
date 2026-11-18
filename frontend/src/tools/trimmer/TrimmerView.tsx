import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToolHeader } from "@/components/ToolHeader";
import { Banner, Button, ClickIn, ClickInHost, DropZone, Field, IconButton, Meter, Section, SegmentedControl, Select, Switch, TextField, TimecodeInput, cx, toast } from "@/components";
import { CropOverlay, MediaPlayer, Timeline, formatMs, parseTimecodeMs, useMediaSource, type MediaPlayerHandle, type Range } from "@/components/media";
import { JobsService, MediaService, TrimAspect, TrimJoin, TrimMode, TrimmerService, type Job } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useShortcut, isEditableTarget } from "@/lib/shortcuts";
import { announceWhenDone, isActive, useJob } from "@/state/jobs";
import { useFileInputs, useModuleOptions } from "@/tools/_kit";
import { ResultRow } from "@/tools/_kit/ResultRow";
import { recordSubmitted } from "@/tools/_kit/session";
import { useEmbedFocus } from "@/tools/_kit/useEmbedFocus";
import type { ToolViewProps } from "@/tools";
import { onTrimmerAction, type TrimmerAction } from "./commands";
import {
  DEFAULT_SETTINGS,
  HEIGHTS,
  MAX_SEGMENTS,
  SIZE_PRESETS,
  addSegment,
  applyRanges,
  aspectRatio,
  buildOptions,
  formatClock,
  frameSummary,
  fullSegment,
  outputSummary,
  keyframeNote,
  keyframeShiftMs,
  needsPrecise,
  sanitizeSettings,
  segmentsError,
  setEnd,
  setStart,
  sourceAspect,
  summaryText,
  type Seg,
  type TrimmerSettings,
} from "./logic";
import styles from "./TrimmerView.module.css";

const MODE_OPTIONS = [
  { value: TrimMode.ModeFast, label: "Fast" },
  { value: TrimMode.ModePrecise, label: "Precise" },
] as const;

const JOIN_OPTIONS = [
  { value: TrimJoin.JoinMerge, label: "One file", tip: "Join all the segments, in order, into a single video" },
  { value: TrimJoin.JoinSeparate, label: "Separate files", tip: "Save each segment as its own file" },
] as const;

const ASPECT_OPTIONS = [
  { value: TrimAspect.AspectKeep, label: "Keep", tip: "Keep the original frame shape" },
  { value: TrimAspect.AspectPortrait, label: "9:16", tip: "Crop to tall 9:16 for reels and stories (re-encodes); drag in the player to choose the area" },
  { value: TrimAspect.AspectSquare, label: "1:1", tip: "Crop to a square (re-encodes); drag in the player to choose the area" },
  { value: TrimAspect.AspectFourFive, label: "4:5", tip: "Crop to 4:5 portrait for the Instagram feed (re-encodes); drag in the player to choose the area" },
  { value: TrimAspect.AspectWide, label: "16:9", tip: "Crop to widescreen 16:9 (re-encodes); drag in the player to choose the area" },
] as const;

const HEIGHT_OPTIONS = HEIGHTS.map((h) => ({ value: String(h), label: h === 0 ? "Keep original" : `${h}p` }));

const SIZE_OPTIONS = [
  { value: "0", label: "None" },
  ...SIZE_PRESETS.map((n) => ({ value: String(n), label: `${n} MB` })),
  { value: "custom", label: "Custom…" },
];

interface TimeFieldProps {
  label: string;
  valueMs: number;
  onCommit: (ms: number) => void;
  tip: string;
}

/** A timecode box that keeps what you type until you leave it. */
function TimeField({ label, valueMs, onCommit, tip }: TimeFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null ? null : parseTimecodeMs(draft);
  const invalid = draft !== null && parsed === null;
  const commit = () => {
    if (draft !== null && parsed !== null) onCommit(parsed);
    setDraft(null);
  };
  return (
    <span data-tip={tip} style={{ display: "contents" }}>
    <TimecodeInput
      aria-label={label}
      value={draft ?? formatMs(valueMs)}
      invalid={invalid}
      onChange={setDraft}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
    </span>
  );
}

function parseShift(resultJson: string): number {
  try {
    const r = JSON.parse(resultJson) as { maxShiftMs?: unknown };
    return typeof r.maxShiftMs === "number" ? r.maxShiftMs : 0;
  } catch {
    return 0;
  }
}

export default function TrimmerView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const embedFocus = useEmbedFocus<HTMLElement>();
  const { files, remove } = inputs;
  const file = files.length > 0 ? files[files.length - 1] : undefined;
  const path = file?.path ?? null;

  // A newly added file replaces the previous one.
  useEffect(() => {
    if (files.length > 1) for (const f of files.slice(0, -1)) remove(f.path);
  }, [files, remove]);

  const media = useMediaSource(path);
  const source = media.status === "ready" ? media.source : undefined;
  const info = source?.info;
  const durationMs = info?.durationMs ?? 0;
  const hasVideo = !!info?.video;
  const kind = hasVideo ? "video" : "audio";

  const [settings, setSettings] = useModuleOptions<TrimmerSettings>(moduleId, DEFAULT_SETTINGS, sanitizeSettings);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [selected, setSelected] = useState("");
  const [playheadMs, setPlayheadMs] = useState(0);
  const [filmstrip, setFilmstrip] = useState<string | undefined>();
  const [waveform, setWaveform] = useState<number[] | undefined>();
  const [keyframes, setKeyframes] = useState<number[] | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; hint?: string } | null>(null);
  const [jobId, setJobId] = useState("");
  const [customSize, setCustomSize] = useState(false);
  const player = useRef<MediaPlayerHandle>(null);
  const job = useJob(jobId);

  // Fresh segments for each opened file.
  const initFor = useRef<string | null>(null);
  useEffect(() => {
    if (!path) {
      initFor.current = null;
      setSegs([]);
      setSelected("");
      return;
    }
    if (!source || initFor.current === path) return;
    initFor.current = path;
    const seg = fullSegment(source.info.durationMs);
    setSegs([seg]);
    setSelected(seg.id);
    setPlayheadMs(0);
    setFilmstrip(undefined);
    setWaveform(undefined);
    setKeyframes(undefined);
    setJobId("");
    setSubmitError(null);
  }, [path, source]);

  // Filmstrip (video) or waveform (audio) for the timeline.
  useEffect(() => {
    if (!path || !source) return;
    let cancelled = false;
    const call = hasVideo ? MediaService.Filmstrip(path, 30, 64).then((u) => !cancelled && setFilmstrip(u)) : MediaService.Waveform(path, 1000).then((w) => !cancelled && setWaveform(w ?? []));
    call.catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // The source object changes when a preview copy replaces it; the media is the same.
  }, [path, hasVideo, !!source]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyframes are only needed to explain fast-mode cuts.
  const wantKeyframes = hasVideo && settings.mode === TrimMode.ModeFast && !!source;
  useEffect(() => {
    if (!path || !wantKeyframes || keyframes) return;
    let cancelled = false;
    MediaService.Keyframes(path)
      .then((k) => !cancelled && setKeyframes(k ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path, wantKeyframes, keyframes]);

  const seek = useCallback((ms: number) => {
    const t = Math.max(0, ms);
    player.current?.seek(t);
    setPlayheadMs(t);
  }, []);

  const nowMs = () => player.current?.currentMs() ?? playheadMs;
  const selectedSeg = segs.find((s) => s.id === selected);

  const doSetStart = () => {
    if (selectedSeg) setSegs((s) => setStart(s, selectedSeg.id, nowMs()));
  };
  const doSetEnd = () => {
    if (selectedSeg) setSegs((s) => setEnd(s, selectedSeg.id, nowMs(), durationMs));
  };
  const doAdd = () => {
    const res = addSegment(segs, nowMs(), durationMs);
    if (!res) {
      toast({ title: segs.length >= MAX_SEGMENTS ? `At most ${MAX_SEGMENTS} segments` : "No room for another segment", tone: "warn" });
      return;
    }
    setSegs(res.segs);
    setSelected(res.id);
  };
  const doDelete = (id: string) => {
    setSegs((list) => {
      const next = list.filter((s) => s.id !== id);
      if (selected === id) setSelected(next[0]?.id ?? "");
      return next;
    });
  };

  const err = source ? segmentsError(segs, durationMs) : "Open a file first";
  const running = !!job && isActive(job);
  const canExport = !!path && !!source && !err && !submitting && !running;

  const doExport = async () => {
    if (!canExport || !path) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const jobs: Job[] | null = await TrimmerService.Enqueue([path], buildOptions(segs, settings, hasVideo, durationMs));
      recordSubmitted((jobs ?? []).map((j) => j.id));
      (jobs ?? []).forEach((j) => announceWhenDone(j.id));
      setJobId(jobs?.[0]?.id ?? "");
    } catch (e) {
      const a = toAppError(e);
      setSubmitError({ message: a.message, hint: a.hint });
    } finally {
      setSubmitting(false);
    }
  };

  // Always call the latest closures from stable subscriptions.
  const live = useRef({ doSetStart, doSetEnd, doAdd, doExport, pick: inputs.pick, pickLibrary: inputs.pickLibrary });
  live.current = { doSetStart, doSetEnd, doAdd, doExport, pick: inputs.pick, pickLibrary: inputs.pickLibrary };
  const hasFile = !!path;
  useEffect(() => {
    return onTrimmerAction((a: TrimmerAction) => {
      const l = live.current;
      if (a === "choose-file") void l.pick();
      else if (a === "choose-library") void l.pickLibrary();
      else if (!hasFile) return;
      else if (a === "set-start") l.doSetStart();
      else if (a === "set-end") l.doSetEnd();
      else if (a === "add-segment") l.doAdd();
      else void l.doExport();
    });
  }, [hasFile]);

  useShortcut("Mod+Enter", () => void doExport(), { when: canExport && embedFocus.active, allowInInputs: true });
  useEffect(() => {
    if (!hasFile || !embedFocus.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "i") live.current.doSetStart();
      else if (k === "o") live.current.doSetEnd();
      else if (e.key === "+" || e.key === "=") live.current.doAdd();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasFile, embedFocus.active]);

  // ---- settings ----

  const patch = (p: Partial<TrimmerSettings>) => setSettings((s) => ({ ...s, ...p }));
  const patchReencode = (p: Partial<TrimmerSettings>) => {
    const next = { ...settings, ...p };
    const switched = settings.mode === TrimMode.ModeFast && needsPrecise(next);
    setSettings({ ...next, mode: switched ? TrimMode.ModePrecise : next.mode });
    if (switched) toast({ title: "Switched to Precise — cropping re-encodes" });
  };

  const sizeChoice = customSize || (settings.maxSizeMB > 0 && !(SIZE_PRESETS as readonly number[]).includes(settings.maxSizeMB)) ? "custom" : String(settings.maxSizeMB);

  // ---- derived view data ----

  const ranges = useMemo<Range[]>(() => segs.map((s, i) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, label: String(i + 1) })), [segs]);
  const fast = settings.mode === TrimMode.ModeFast;
  const ratio = aspectRatio(settings.aspect);
  const srcRatio = sourceAspect(info);
  const frameMs = info?.video?.fps ? 1000 / info.video.fps : undefined;

  const result = job && job.status === "done" ? job : undefined;
  const shift = result ? parseShift(result.resultJson) : 0;

  // ---- render ----

  const title = file ? (
    <ToolHeader aria-label="Video Trimmer">
      <span className={styles.fileName} data-tip={file.path}>
        <span>{file.name}</span>
        <Button
          size="sm"
          variant="ghost"
          data-tip="Pick a different file to trim; this one is closed"
          onClick={() => {
            inputs.clear();
            void inputs.pick();
          }}
        >
          Choose another
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="history"
          collapsible
          data-tip="Pick a different file to trim from the Library; this one is closed"
          onClick={() => {
            inputs.clear();
            void inputs.pickLibrary();
          }}
        >
          From Library…
        </Button>
      </span>
    </ToolHeader>
  ) : null;

  if (!file) {
    return (
      <ClickInHost className={styles.host}>
      <section ref={embedFocus.ref} className={cx(styles.root, styles.rootEmpty)} aria-label="Video Trimmer">
        <div className={styles.empty}>
          <DropZone id="trimmer-drop" className={styles.fullDrop} label="Drop a video or audio file" hint="Cut one or more ranges, losslessly or frame-accurately." icon="scissors">
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", justifyContent: "center" }}>
              <Button variant="secondary" icon="folder-open" data-tip="Choose a video or audio file to trim" onClick={() => void inputs.pick()}>
                Choose file
              </Button>
              <Button variant="secondary" icon="history" data-tip="Pick a video or audio file Toolbox already made (the Library)" onClick={() => void inputs.pickLibrary()}>
                From Library…
              </Button>
            </div>
          </DropZone>
        </div>
      </section>
      </ClickInHost>
    );
  }

  const preparing = media.status === "preparing";
  const loading = media.status === "loading" || media.status === "idle";

  return (
    <ClickInHost className={styles.host}>
    <section ref={embedFocus.ref} className={styles.root} aria-label="Video Trimmer">
      {title}

      {media.status === "error" && (
        <Banner
          tone="danger"
          title={media.error?.message ?? "This file can't be opened"}
          action={
            <Button size="sm" data-tip="Try opening the file again" onClick={media.retry}>
              Retry
            </Button>
          }
        >
          {media.error?.hint}
        </Banner>
      )}

      <div className={styles.layout}>
        <div className={styles.main}>
          {source && info ? (
            <MediaPlayer
              ref={player}
              className={styles.player}
              source={source}
              kind={kind}
              path={path ?? undefined}
              waveform={waveform}
              onTime={setPlayheadMs}
              overlay={
                ratio && srcRatio && hasVideo
                  ? (rect) => <CropOverlay rect={rect} aspect={ratio} sourceAspect={srcRatio} x={settings.cropX} y={settings.cropY} onChange={(x, y) => patch({ cropX: x, cropY: y })} />
                  : undefined
              }
            />
          ) : (
            <div className={styles.placeholder} role="status">
              {preparing ? (
                <>
                  <span>Preparing a preview copy… {Math.round((media.progress ?? 0) * 100)}%</span>
                  <Meter className={styles.placeholderBar} value={media.progress ?? -1} label="Preview copy progress" />
                  <span>This format can't play in the app directly; making a preview copy. Your export uses the original.</span>
                </>
              ) : loading ? (
                <span>Loading…</span>
              ) : null}
            </div>
          )}

          {source && (
            <Timeline
              durationMs={durationMs}
              playheadMs={playheadMs}
              onSeek={seek}
              filmstripUrl={filmstrip}
              waveform={hasVideo ? undefined : waveform}
              ranges={ranges}
              onRangesChange={(r) => setSegs((prev) => applyRanges(prev, r))}
              selectedRange={selected}
              onSelectRange={setSelected}
              keyframes={fast && hasVideo ? keyframes : undefined}
              frameMs={frameMs}
              zoomable
            />
          )}
        </div>

        <div className={styles.side}>
          <Section label="Segments" tip="The parts of the file to keep. Each one becomes part of the output">
            <div className={styles.stack}>
              <div className={styles.segActions}>
                <Button size="sm" data-tip="Start the selected segment at the playhead" onClick={doSetStart} disabled={!selectedSeg || !source} kbd="I">
                  Set start
                </Button>
                <Button size="sm" data-tip="End the selected segment at the playhead" onClick={doSetEnd} disabled={!selectedSeg || !source} kbd="O">
                  Set end
                </Button>
                <Button size="sm" icon="plus" data-tip="Add another segment to keep, starting at the playhead" onClick={doAdd} disabled={!source} kbd="+">
                  Add segment
                </Button>
              </div>
              <ul className={styles.segList} aria-label="Segments" data-tip="Click a segment to select it and jump to its start">
                {segs.map((s, i) => {
                  const shiftMs = fast && hasVideo ? keyframeShiftMs(keyframes, s.startMs) : 0;
                  return (
                    <li
                      key={s.id}
                      className={cx(styles.segRow, s.id === selected && styles.selected)}
                      aria-current={s.id === selected || undefined}
                      onClick={() => {
                        setSelected(s.id);
                        seek(s.startMs);
                      }}
                    >
                      <span className={styles.segIndex} data-tip="Segment number, matching the numbered ranges on the timeline">{i + 1}</span>
                      <div onClick={(e) => e.stopPropagation()}>
                        <TimeField tip="Where this segment starts; type a time like 1:23.4 and press Enter" label={`Segment ${i + 1} start`} valueMs={s.startMs} onCommit={(ms) => setSegs((l) => setStart(l, s.id, ms))} />
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <TimeField tip="Where this segment ends; type a time like 1:23.4 and press Enter" label={`Segment ${i + 1} end`} valueMs={s.endMs} onCommit={(ms) => setSegs((l) => setEnd(l, s.id, ms, durationMs))} />
                      </div>
                      <span className={styles.segDuration} data-tip="Length of this segment">{formatClock(s.endMs - s.startMs)}</span>
                      <IconButton
                        size="sm"
                        icon="trash-2"
                        label={`Delete segment ${i + 1}`}
                        data-tip="Remove this segment from the output"
                        onClick={(e) => {
                          e.stopPropagation();
                          doDelete(s.id);
                        }}
                      />
                      {shiftMs > 0 && <span className={styles.segNote} data-tip="Fast mode can only cut on keyframes; switch to Precise for an exact cut">{keyframeNote(shiftMs)}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          </Section>

          <Section label="Export" tip="How the trimmed file is made">
            <div className={styles.stack}>
              <Field label="Mode" hint={fast ? "Cuts land on keyframes; the picture isn't re-encoded." : "Frame-accurate cuts; the video is re-encoded."}>
                {() => (
                  <SegmentedControl
                    aria-label="Mode"
                    value={settings.mode}
                    onChange={(mode) => patch({ mode })}
                    options={[
                      { ...MODE_OPTIONS[0], label: "Fast · no quality loss", disabled: needsPrecise(settings), tip: needsPrecise(settings) ? "Unavailable while framing, resizing or a size limit is set" : "Copy the video as it is, with no quality loss; cuts snap to the nearest keyframe" },
                      { ...MODE_OPTIONS[1], label: "Precise · re-encode", tip: "Cut exactly on the frame you chose; the video is re-encoded, which takes longer" },
                    ]}
                    fullWidth
                    size="sm"
                  />
                )}
              </Field>
              {fast && needsPrecise(settings) && <p className={styles.hint}>Fast is unavailable while framing, resizing or a size limit is set.</p>}

            </div>
          </Section>

          <div className={styles.rows}>
            {hasVideo && (
              <ClickIn icon="crop" title="Frame" summary={frameSummary(settings)} tip="Crop to a tall, square or wide shape; drag in the player to choose the area" width={320}>
                <Field label="Crop to" hint="Cropping re-encodes. Drag in the player to choose the area.">
                  {() => <SegmentedControl aria-label="Frame" value={settings.aspect} onChange={(aspect) => patchReencode({ aspect })} options={ASPECT_OPTIONS} fullWidth size="sm" />}
                </Field>
              </ClickIn>
            )}
            <ClickIn icon="sliders-horizontal" title="Output" summary={outputSummary(settings, segs.length)} tip="How the pieces are joined, and limits on size and height" width={320}>
              <div className={styles.stack}>
              {segs.length >= 2 && (
                <Field label="Join">
                  {() => <SegmentedControl aria-label="Join" value={settings.join} onChange={(join) => patch({ join })} options={JOIN_OPTIONS} fullWidth size="sm" />}
                </Field>
              )}

              <Field label="Size limit">
                {(c) => (
                  <div className={styles.inline}>
                    <Select
                      id={c.id}
                      data-tip="Shrink the file to fit under a size, for example 25 MB for email; this re-encodes"
                      value={sizeChoice}
                      options={SIZE_OPTIONS}
                      onChange={(v) => {
                        if (v === "custom") {
                          setCustomSize(true);
                          if (settings.maxSizeMB === 0) patchReencode({ maxSizeMB: 100 });
                        } else {
                          setCustomSize(false);
                          patchReencode({ maxSizeMB: Number(v) });
                        }
                      }}
                    />
                    {sizeChoice === "custom" && (
                      <TextField
                        aria-label="Custom size limit (MB)"
                        data-tip="Largest output size in megabytes (1 to 4000)"
                        type="number"
                        min={1}
                        max={4000}
                        mono
                        value={settings.maxSizeMB || ""}
                        onChange={(e) => {
                          const n = Math.round(Number(e.target.value));
                          patchReencode({ maxSizeMB: Number.isFinite(n) ? Math.min(4000, Math.max(0, n)) : 0 });
                        }}
                      />
                    )}
                  </div>
                )}
              </Field>

              {hasVideo && (
                <Field label="Max height">
                  {(c) => <Select id={c.id} data-tip="Scale the video down so it is no taller than this; smaller files, lower detail" value={String(settings.maxHeight)} options={HEIGHT_OPTIONS} onChange={(v) => patchReencode({ maxHeight: Number(v) })} />}
                </Field>
              )}

              {hasVideo && <Switch label="Remove audio" tip="Export the video without any sound" checked={settings.removeAudio} onChange={(removeAudio) => patch({ removeAudio })} />}
              </div>
            </ClickIn>
          </div>
        </div>
      </div>

      {submitError && (
        <Banner tone="danger" title={submitError.message}>
          {submitError.hint}
        </Banner>
      )}
      {job && job.status === "failed" && (
        <Banner tone="danger" title={job.error || "The trim failed"}>
          {job.errorHint}
        </Banner>
      )}

      {result && (
        <div className={styles.result} aria-label="Results">
          <Section label="Results" tip="The exported file">
            {result.outputs.map((o) => (
              <ResultRow key={o.id} path={o.path} outputId={o.id} name={o.name} sizeBytes={o.sizeBytes} icon="scissors" />
            ))}
          </Section>
          {shift > 500 && <p className={styles.hint}>Fast mode moved a cut up to {(shift / 1000).toFixed(1)} s earlier to land on a keyframe.</p>}
        </div>
      )}

      <div className={styles.footer}>
        {running && job ? (
          <div className={styles.progress}>
            <Meter value={job.progress} label="Export progress" />
            <span className={styles.progressMsg}>{job.message || "Exporting…"}</span>
            <Button size="sm" variant="secondary" data-tip="Stop exporting" onClick={() => void JobsService.Cancel(job.id).catch(() => undefined)}>
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <span className={styles.summary} data-tip="What the export will produce: segments, total length and estimated size">{source ? summaryText(segs, settings, info?.sizeBytes ?? 0, durationMs) : "Waiting for the file…"}</span>
            <Button variant="primary" icon="scissors" kbd="Mod+Enter" loading={submitting} disabled={!canExport} data-tip={err ?? "Cut the segments and save the result to your library"} onClick={() => void doExport()}>
              Export
            </Button>
          </>
        )}
      </div>
    </section>
    </ClickInHost>
  );
}
