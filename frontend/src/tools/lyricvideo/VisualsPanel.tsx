/**
 * The Visuals panel (formerly the Visuals step): animated visuals that react to
 * the song (a quick pick, or the full designer, which opens on the stage), or a
 * classic background. Also the instrument separation and the listening that
 * feeds the visuals. It submits jobs, so it only opens inline.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, ClickIn, IconButton, Meter, SegmentedControl, Switch, toast } from "@/components";
import { VisualsPicker } from "@/components/viz";
import { PacksService, type VisualsSpec } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { usePacks } from "@/state/packs";
import { DepsGate } from "@/tools/_kit";
import { makeInVisualizer } from "./actions";
import { useEngineGate } from "./engine";
import { toLines } from "./logic";
import type { VisualsMode } from "./options";
import { LYRIC_VIDEO_ID, useLyricVideo } from "./store";
import { STEMS_MODEL, aspectNumber, componentInstalled, designLabel, instrumentsState, lookForMode } from "./visuals";
import styles from "./panels.module.css";

const MODES: Array<{ value: VisualsMode; label: string; tip: string }> = [
  { value: "quick", label: "Quick", tip: "Pick a ready-made animated design from a few suggestions" },
  { value: "designer", label: "Full designer", tip: "Tune colours, reactions, layers and the timeline yourself" },
  { value: "classic", label: "Classic background", tip: "Skip the animation and use a cover, colour, gradient, image or video" },
];

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

export default function VisualsPanel() {
  const prefs = useLyricVideo((s) => s.prefs);
  const songPath = useLyricVideo((s) => s.songPath);
  const rows = useLyricVideo((s) => s.rows);
  const saveStems = useLyricVideo((s) => s.saveStems);
  const listening = useLyricVideo((s) => s.listening);
  const designerOpen = useLyricVideo((s) => s.designerOpen);
  const packs = usePacks((s) => s.list);
  const gate = useEngineGate("visuals");
  const st = useLyricVideo.getState;
  const look = prefs.look;
  const mode = prefs.visualsMode;
  const stemsInstalled = componentInstalled(packs, STEMS_MODEL);
  const stems = look.visuals.stems && stemsInstalled;
  const status = listening?.status ?? "idle";
  const busy = status === "checking" || status === "running";
  const pct = Math.round((listening?.progress ?? 0) * 100);
  const lines = useMemo(() => toLines(rows), [rows]);

  const setMode = (m: VisualsMode) => {
    st().setPrefs((o) => ({ ...o, visualsMode: m, look: lookForMode(o.look, m) }));
    st().setDesignerOpen(m === "designer");
  };
  const setVisuals = (v: VisualsSpec) => st().setPrefs((o) => ({ ...o, look: { ...o.look, background: "visualizer", visuals: v } }));
  const setStems = (on: boolean) => st().setPrefs((o) => ({ ...o, look: { ...o.look, visuals: { ...o.look.visuals, stems: on } } }));

  // Ticking "save the stems" after the listening finished needs a new run (separation happens again).
  const wantSave = useRef(false);
  const startRef = useRef(listening?.start);
  startRef.current = listening?.start;
  useEffect(() => {
    if (wantSave.current && saveStems && stems) {
      wantSave.current = false;
      const t = setTimeout(() => startRef.current?.(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [saveStems, stems]);

  // Opening this panel is what starts the listening.
  useEffect(() => {
    useLyricVideo.getState().setVisualsEngaged(true);
  }, []);

  if (!songPath) return null;
  return (
    <div className={styles.panel}>
      {gate.blocked && <DepsGate moduleId={LYRIC_VIDEO_ID} />}
      {!stemsInstalled && <StemsModelBanner />}

      <SegmentedControl aria-label="Visuals" data-tip="How to choose the visuals" value={mode} options={MODES} onChange={setMode} />

      {mode === "classic" && (
        <Banner tone="info" title="Classic background">
          The Look panel offers the cover, colour, gradient, image and video backgrounds.
        </Banner>
      )}
      {mode === "quick" &&
        (status === "ready" ? (
          <VisualsPicker
            // The picker keeps its own copy of the switches: remount when ours change.
            key={String(stems)}
            inputPath={songPath}
            lines={lines}
            value={look.visuals.showJson ? { ...look.visuals, stems } : null}
            onChange={setVisuals}
            mode="background"
            aspect={aspectNumber(prefs.aspect)}
            onOpenDesigner={() => setMode("designer")}
          />
        ) : (
          !busy && status !== "error" && <div className={styles.hint}>The designs appear once the song has been listened to.</div>
        ))}
      {mode === "designer" && (
        <div className={styles.form}>
          {status === "ready" ? (
            <Button variant="secondary" icon="sparkles" onClick={() => st().setDesignerOpen(!designerOpen)} data-tip="The designer takes the room of the preview; open the preview again to see the words">
              {designerOpen ? "Show the preview" : "Open the designer"}
            </Button>
          ) : (
            <div className={styles.hint}>{busy ? "The designer opens once the song has been listened to." : "The designer needs the song to be listened to first."}</div>
          )}
        </div>
      )}

      <ClickIn icon="layers" title="Instruments" summary={instrumentsState(stems, stemsInstalled, saveStems)} tip="Splitting the song into instruments gives richer reactions" width={360}>
        <div className={styles.panel}>
          <Switch
            tip={!stemsInstalled ? "Download the instrument separation model first" : busy ? "Wait until the song has been listened to" : "Split the song into drums, bass, vocals and other so each can drive its own visuals"}
            checked={stems}
            disabled={!stemsInstalled || busy}
            onChange={setStems}
            label="Separate instruments (drums, bass, vocals, other)"
          />
          <span className={styles.hint}>Richer reactions; takes about as long as the song.</span>
          <label className={styles.check} data-tip={stems ? "Keep the separated instrument tracks as audio files in your Library" : "Turn on Separate instruments first"}>
            <input
              type="checkbox"
              checked={saveStems && stems}
              disabled={!stems || busy}
              onChange={(e) => {
                wantSave.current = status === "ready" && e.target.checked;
                st().setSaveStems(e.target.checked);
              }}
            />
            Also save the stems to the Library
          </label>
        </div>
      </ClickIn>

      {listening && status === "running" && (
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
      {listening && status === "error" && listening.error && (
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
      {listening && status === "ready" && listening.ref?.summary && (
        <span className={styles.hint} data-testid="listened" data-tip="What the app found when it listened: tempo, key and whether instruments were split">
          Listened: {listening.ref.summary.tempo ? `${Math.round(listening.ref.summary.tempo)} bpm` : "tempo unknown"}
          {listening.ref.summary.key ? `, ${listening.ref.summary.key}` : ""}
          {listening.ref.summary.hasStems ? ", instruments separated" : ""}
        </span>
      )}

      <div className={styles.buttonRow}>
        <span data-testid="design-label" data-tip="The visuals the video will use">
          Design: <strong>{designLabel(look)}</strong>
        </span>
      </div>
      <div className={styles.buttonRow}>
        <Button variant="ghost" size="sm" icon="external-link" onClick={() => makeInVisualizer(false)} data-tip="Open Visualizer with this song and these lyrics to make the whole video there">
          Make the whole video in Visualizer
        </Button>
        <IconButton size="sm" icon="app-window" label="Open Visualizer in its own window" data-tip="Open Visualizer with this song and these lyrics in its own window" onClick={() => makeInVisualizer(true)} />
      </div>
    </div>
  );
}
