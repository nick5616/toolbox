/**
 * Rail ▸ Steal a look, Chaos and Motion (Phase 21 SPEC §E1).
 * - Steal a look: a reference picture's colours as a `transfer` op.
 * - Chaos: Surprise me / Again / a seed you can type, and per-op locks.
 * - Motion (videos): per-op animation speed and wave, and beat sync.
 */
import { useState } from "react";
import { FromLibraryButton } from "@/blocks/library-picker";
import { Banner, Button, IconButton, Select, Slider, Switch, TextField, toast } from "@/components";
import { opDef } from "@/grade/ops";
import type { GradeAnim } from "@/grade/types";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { pickReference, stealFrom } from "./actions";
import { opLabel } from "./recipe";
import { baseName, useGrade } from "./store";
import styles from "./Grade.module.css";

export function StealPanel() {
  const steal = useGrade((s) => s.steal);
  const selected = useGrade((s) => s.selected);
  const busy = steal.phase === "busy";
  const why = !selected ? "Open a picture first" : "";
  return (
    <div className={styles.panel}>
      <p className={styles.note}>Pick a reference picture and its colours are matched onto yours, shadows, mids and highlights separately. Only the colour numbers are kept, not the reference.</p>
      <div className={styles.actions}>
        <Button size="sm" variant="primary" icon="image" loading={busy} aria-disabled={!!why || undefined} data-tip={why || "Choose a reference picture from your computer"} onClick={() => !why && void pickReference("file")}>
          Choose a picture…
        </Button>
        <FromLibraryButton
          title="Choose a reference picture from Library"
          exts={[".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".heic", ".heif", ".bmp"]}
          multiple={false}
          size="sm"
          disabled={!!why || busy}
          onPick={(p) => p[0] && void stealFrom(p[0])}
        />
      </div>
      {steal.phase === "idle" && steal.ref !== "" && <p className={styles.note}>Matched to “{baseName(steal.ref)}”. It's a “Transfer” op in the Look panel; lower its amount to taste.</p>}
      {steal.phase === "error" && (
        <Banner tone="danger" title="Couldn't read that picture">
          {steal.error}
        </Banner>
      )}
    </div>
  );
}

export function ChaosPanel() {
  const seed = useGrade((s) => s.chaosSeed);
  const ops = useGrade((s) => s.recipe.ops);
  const locked = useGrade((s) => s.locked);
  const video = useGrade((s) => s.src?.info.kind === "video");
  const [typed, setTyped] = useState<string | null>(null);
  const apply = (raw: string) => {
    const n = Number(raw.replace(/[^0-9]/g, ""));
    if (raw.trim() !== "" && Number.isFinite(n)) useGrade.getState().surprise(n, video);
    setTyped(null);
  };
  return (
    <div className={styles.panel}>
      <p className={styles.note}>Chaos builds a random look of 3 to 8 ops, wilder as Wildness goes up. The same seed always makes the same look.</p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          icon="dices"
          data-tip="Build a random look from a new seed"
          onClick={() => useGrade.getState().surprise(Math.floor(Math.random() * 100000), video)}
        >
          Surprise me
        </Button>
        <Button size="sm" variant="secondary" icon="refresh-cw" data-tip="Roll again with the next seed; locked ops stay" onClick={() => useGrade.getState().again(video)}>
          Again
        </Button>
      </div>
      <label className={styles.param}>
        <span className={styles.paramLabel}>Seed</span>
        <TextField
          size="sm"
          mono
          value={typed ?? `#${seed}`}
          aria-label="Seed"
          data-tip="Type a seed and press Enter to make exactly that look again"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => setTyped(null)}
          onKeyDown={(e) => e.key === "Enter" && apply(e.currentTarget.value)}
        />
      </label>
      {ops.length > 0 && (
        <>
          <span className={styles.paramLabel}>Keep these when rerolling</span>
          <ul className={styles.lockList}>
            {ops.map((o) => {
              const on = locked.includes(o.id);
              return (
                <li key={o.id}>
                  <Switch checked={on} onChange={() => useGrade.getState().toggleLock(o.id)} label={opLabel(o.kind)} tip={on ? "Unlock: Chaos may replace this op" : "Lock: this op survives rerolls"} />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

const WAVES: ReadonlyArray<{ value: GradeAnim["wave"]; label: string }> = [
  { value: "sine", label: "Smooth" },
  { value: "saw", label: "Ramp" },
  { value: "beat", label: "On the beat" },
  { value: "bar", label: "On the bar" },
];

const AUDIO_EXTS = [".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"];

export function MotionPanel() {
  const video = useGrade((s) => s.src?.info.kind === "video");
  const selected = useGrade((s) => s.selected);
  const ops = useGrade((s) => s.recipe.ops);
  const beat = useGrade((s) => s.beat);
  const setAnim = useGrade((s) => s.setAnim);
  const setBeat = useGrade((s) => s.setBeat);
  if (!video) {
    return (
      <div className={styles.panel}>
        <p className={styles.note}>{selected ? "Motion is for videos: a picture holds still." : "Open a video to make its look move."}</p>
      </div>
    );
  }
  const pickSong = async () => {
    try {
      const p = (await FilesService.PickWith("Choose a song to sync to", AUDIO_EXTS, false)) ?? [];
      if (p[0]) setBeat({ song: p[0], on: true });
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
  const animatable = ops.filter((o) => opDef(o.kind)?.animatable ?? ["huecycle", "gradmap"].includes(o.kind));
  return (
    <div className={styles.panel}>
      {animatable.length === 0 ? (
        <p className={styles.note}>None of this look's ops can move. Hue cycle and Gradient map can: add one in the Look panel.</p>
      ) : (
        <ul className={styles.motionList} aria-label="Ops that can move">
          {animatable.map((o) => (
            <li key={o.id} className={styles.motionRow}>
              <Switch checked={!!o.anim} onChange={(on) => setAnim(o.id, on ? { speed: 0.5, wave: "sine" } : null)} label={opLabel(o.kind)} tip="Make this op move over time" />
              {o.anim && (
                <>
                  <label className={styles.param}>
                    <span className={styles.paramLabel}>Speed</span>
                    <Slider value={o.anim.speed} min={0.05} max={6} step={0.05} onChange={(speed) => o.anim && setAnim(o.id, { ...o.anim, speed })} aria-label={`${opLabel(o.kind)} speed`} data-tip="Cycles per 10 seconds. Fast swings are slowed to keep flashing safe" format={(v) => `${v.toFixed(2)}×`} />
                  </label>
                  <label className={styles.param}>
                    <span className={styles.paramLabel}>Wave</span>
                    <Select size="sm" value={o.anim.wave} options={WAVES.map((w) => ({ value: w.value, label: w.label }))} aria-label={`${opLabel(o.kind)} wave`} onChange={(wave) => o.anim && setAnim(o.id, { ...o.anim, wave })} />
                  </label>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Switch checked={beat.on} onChange={(on) => setBeat({ on })} label="Sync to the beat" tip="Pulses land on beats or bars of the video's audio, or of a song you choose" />
      {beat.on && (
        <div className={styles.beatSong}>
          <span className={styles.stopsNote}>{beat.song ? baseName(beat.song) : "The video's own audio"}</span>
          <Button size="sm" variant="secondary" data-tip="Use another song for the beat" onClick={() => void pickSong()}>
            Choose a song…
          </Button>
          <FromLibraryButton title="Choose a song from Library" exts={AUDIO_EXTS} multiple={false} size="sm" onPick={(p) => p[0] && setBeat({ song: p[0], on: true })} />
          {beat.song && <IconButton label="Use the video's own audio" icon="x" size="sm" onClick={() => setBeat({ song: "" })} />}
        </div>
      )}
      <p className={styles.note}>Animation never flashes more than 3 times a second: fast or large swings are slowed or reduced automatically.</p>
      {beat.on && <p className={styles.note}>The beat is read from the audio when you export, so the first export takes a little longer.</p>}
    </div>
  );
}
