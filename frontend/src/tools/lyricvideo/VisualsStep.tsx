import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, ClickIn, IconButton, Meter, SegmentedControl, Switch, toast } from "@/components";
import { VisualsPicker, type VisualsAnalysis } from "@/components/viz";
import { PacksService, type LyricLook, type TimedLine, type VisualsSpec } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { DepsGate } from "@/tools/_kit";
import { withoutText } from "@/blocks/visuals/designer/model";
import { useShowHistory, useUndoKeys } from "@/blocks/visuals/designer/useShowHistory";
import { VisualDesigner } from "@/blocks/visuals/designer/VisualDesigner";
import type { Show } from "@/viz/types";
import type { Row } from "./logic";
import type { Prefs, RememberedLook, VisualsMode } from "./options";
import { LyricOverlay } from "./Preview";
import { aspectNumber, designLabel, initialDesign, instrumentsState, lookForMode, showOf } from "./visuals";
import styles from "./VisualsStep.module.css";

export interface VisualsStepProps {
  moduleId: string;
  songPath: string;
  prefs: Prefs;
  setPrefs: (next: Prefs | ((p: Prefs) => Prefs)) => void;
  /** The lyric sheet as timed lines (the words given to the analysis). */
  lines: TimedLine[];
  rows: Row[];
  meta: { title: string; artist: string };
  listening: VisualsAnalysis;
  /** The instrument separation model is installed. */
  stemsInstalled: boolean;
  saveStems: boolean;
  onSaveStems: (v: boolean) => void;
  /** The AI engine is needed and missing. */
  engineBlocked: boolean;
  onMakeInVisualizer: (inWindow?: boolean) => void;
  onContinue: () => void;
}

const MODES: Array<{ value: VisualsMode; label: string; tip: string }> = [
  { value: "quick", label: "Quick", tip: "Pick a ready-made animated design from a few suggestions" },
  { value: "designer", label: "Full designer", tip: "Tune colours, reactions, layers and the timeline yourself" },
  { value: "classic", label: "Classic background", tip: "Skip the animation and use a cover, colour, gradient, image or video" },
];

/** Step 3: choose visuals that react to the song, or keep a classic background. */
export function VisualsStep(p: VisualsStepProps) {
  const { prefs, setPrefs, listening } = p;
  const look = prefs.look;
  const mode = prefs.visualsMode;
  const stems = look.visuals.stems && p.stemsInstalled;
  const busy = listening.status === "checking" || listening.status === "running";
  const pct = Math.round(listening.progress * 100);

  const setMode = (m: VisualsMode) => setPrefs((o) => ({ ...o, visualsMode: m, look: lookForMode(o.look, m) }));
  const setVisuals = (v: VisualsSpec) => setPrefs((o) => ({ ...o, look: { ...o.look, background: "visualizer", visuals: v } }));
  const setStems = (on: boolean) => setPrefs((o) => ({ ...o, look: { ...o.look, visuals: { ...o.look.visuals, stems: on } } }));

  // Ticking "save the stems" after the listening finished needs a new run (separation happens again).
  const wantSave = useRef(false);
  const startRef = useRef(listening.start);
  startRef.current = listening.start;
  useEffect(() => {
    if (wantSave.current && p.saveStems && stems) {
      wantSave.current = false;
      // After the hook's own re-check of the new options, which would otherwise discard this run.
      const t = setTimeout(() => startRef.current(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [p.saveStems, stems]);

  const label = designLabel(look);
  const instrumentsSummary = instrumentsState(stems, p.stemsInstalled, p.saveStems);

  return (
    <div className={styles.root}>
      <div className={styles.panel}>
          {p.engineBlocked && <DepsGate moduleId={p.moduleId} />}
          {!p.stemsInstalled && <StemsModelBanner />}
          <ClickIn
            icon="layers"
            title="Instruments"
            summary={instrumentsSummary}
            tip="Splitting the song into instruments gives richer reactions"
            width={360}
            className={styles.rowLauncher}
          >
          <div className={styles.panel}>
          <Switch
            tip={!p.stemsInstalled ? "Download the instrument separation model first" : busy ? "Wait until the song has been listened to" : "Split the song into drums, bass, vocals and other so each can drive its own visuals"}
            checked={stems}
            disabled={!p.stemsInstalled || busy}
            onChange={setStems}
            label="Separate instruments (drums, bass, vocals, other)"
          />
          <span className={styles.hint}>Richer reactions; takes about as long as the song.</span>
          <label className={styles.check} data-tip={stems ? "Keep the separated instrument tracks as audio files in your Library" : "Turn on Separate instruments first"}>
            <input
              type="checkbox"
              checked={p.saveStems && stems}
              disabled={!stems || busy}
              onChange={(e) => {
                wantSave.current = listening.status === "ready" && e.target.checked;
                p.onSaveStems(e.target.checked);
              }}
            />
            Also save the stems to the Library
          </label>
          </div>
          </ClickIn>
          {listening.status === "running" && (
            <div className={styles.listening} role="status">
              <div className={styles.listeningText}>
                <span>Listening to the song…{pct > 0 ? ` ${pct}%` : ""}</span>
                {listening.stage && <span className={styles.hint}>{listening.stage}</span>}
                <Button size="sm" variant="ghost" onClick={listening.cancel} data-tip="Stop listening to the song">
                  Cancel
                </Button>
              </div>
              <Meter value={listening.progress > 0 ? listening.progress : -1} label="Listening progress" size="sm" />
            </div>
          )}
          {listening.status === "error" && listening.error && (
            <Banner
              tone="danger"
              title={listening.error.message}
              action={
                <Button size="sm" onClick={listening.start} data-tip="Listen to the song again">
                  Try again
                </Button>
              }
            >
              {listening.error.hint}
            </Banner>
          )}
          {listening.status === "ready" && listening.ref?.summary && (
            <span className={styles.hint} data-testid="listened" data-tip="What the app found when it listened: tempo, key and whether instruments were split">
              Listened: {listening.ref.summary.tempo ? `${Math.round(listening.ref.summary.tempo)} bpm` : "tempo unknown"}
              {listening.ref.summary.key ? `, ${listening.ref.summary.key}` : ""}
              {listening.ref.summary.hasStems ? ", instruments separated" : ""}
            </span>
          )}
      </div>

      <SegmentedControl aria-label="Visuals" data-tip="How to choose the visuals" value={mode} options={MODES} onChange={setMode} />

      <div className={styles.body}>
        {mode === "classic" && (
          <Banner tone="info" title="Classic background">
            The Look step offers the cover, colour, gradient, image and video backgrounds.
          </Banner>
        )}
        {mode === "quick" &&
          (listening.status === "ready" ? (
            <VisualsPicker
              // The picker keeps its own copy of the switches: remount when ours change.
              key={String(stems)}
              inputPath={p.songPath}
              lines={p.lines}
              value={look.visuals.showJson ? { ...look.visuals, stems } : null}
              onChange={setVisuals}
              mode="background"
              aspect={aspectNumber(prefs.aspect)}
              onOpenDesigner={() => setMode("designer")}
            />
          ) : (
            !busy && listening.status !== "error" && <div className={styles.hint}>The designs appear once the song has been listened to.</div>
          ))}
        {mode === "designer" &&
          (listening.analysis ? (
            <DesignerHost
              songPath={p.songPath}
              analysis={listening.analysis}
              look={look}
              rows={p.rows}
              meta={p.meta}
              aspect={aspectNumber(prefs.aspect)}
              onDesign={(show) =>
                setPrefs((o) => ({
                  ...o,
                  look: { ...o.look, background: "visualizer", visuals: { ...o.look.visuals, showJson: JSON.stringify(withoutText(show)) } },
                }))
              }
            />
          ) : (
            <div className={styles.hint}>{busy ? "The designer opens once the song has been listened to." : "The designer needs the song to be listened to first."}</div>
          ))}
      </div>

      <div className={styles.footer}>
        <span className={styles.design} data-testid="design-label" data-tip="The visuals the video will use">
          Design: <strong>{label}</strong>
        </span>
        <span className={styles.spacer} />
        <Button variant="ghost" size="sm" icon="external-link" onClick={() => p.onMakeInVisualizer()} data-tip="Open Visualizer with this song and these lyrics to make the whole video there">
          Make the whole video in Visualizer
        </Button>
        <IconButton size="sm" icon="app-window" label="Open Visualizer in its own window" data-tip="Open Visualizer with this song and these lyrics in its own window" onClick={() => p.onMakeInVisualizer(true)} />
        <Button onClick={p.onContinue} data-tip="Go on to the shape, background and text look">Continue to Look</Button>
      </div>
    </div>
  );
}

/** Offers the instrument separation model when it isn't downloaded. */
function StemsModelBanner() {
  const [busy, setBusy] = useState(false);
  const install = async () => {
    setBusy(true);
    try {
      await PacksService.InstallFor("visualizer");
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner
      tone="info"
      title="The instrument separation model isn't downloaded"
      action={
        <Button variant="primary" size="sm" icon="download" loading={busy} onClick={() => void install()} data-tip="Download the model once; after that it works offline">
          Download
        </Button>
      }
    >
      It downloads once and then works offline.
    </Banner>
  );
}

interface DesignerHostProps {
  songPath: string;
  analysis: NonNullable<VisualsAnalysis["analysis"]>;
  look: RememberedLook;
  rows: Row[];
  meta: { title: string; artist: string };
  aspect: number;
  onDesign: (show: Show) => void;
}

/** The embedded designer with this tool's own words drawn over its canvas. */
function DesignerHost({ songPath, analysis, look, rows, meta, aspect, onDesign }: DesignerHostProps) {
  const start = useMemo(() => {
    const own = showOf(look.visuals);
    return { show: own ?? initialDesign(), fresh: own === null };
    // The design a session starts from is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const history = useShowHistory(start.show as Show);
  useUndoKeys(history);

  const emitted = useRef<Show | null>(start.fresh ? null : history.show);
  useEffect(() => {
    if (emitted.current === history.show) return;
    emitted.current = history.show;
    onDesign(history.show);
  });

  const lyricLook = useMemo<LyricLook>(() => ({ ...look, title: meta.title, artist: meta.artist }), [look, meta]);
  if (!start.show) return <Banner tone="danger" title="No designs are available" />;

  return (
    <div className={styles.designer}>
      <div className={styles.bar}>
        <IconButton icon="undo-2" label="Undo" data-tip="Undo the last design change" kbd="Mod+Z" disabled={!history.canUndo} onClick={history.undo} />
        <IconButton icon="redo-2" label="Redo" data-tip="Redo the change you just undid" kbd="Mod+Shift+Z" disabled={!history.canRedo} onClick={history.redo} />
        <span className={styles.name} data-tip="The name of this design">{history.show.name}</span>
      </div>
      <VisualDesigner
        inputPath={songPath}
        analysis={analysis}
        show={history.show}
        onChange={history.set}
        aspect={aspect}
        mode="full"
        player={null}
        text={{ overlay: (_rect, timeMs) => <LyricOverlay look={lyricLook} rows={rows} ms={timeMs} /> }}
        tabs={["presets", "look", "reactions", "layers", "timeline"]}
      />
    </div>
  );
}
