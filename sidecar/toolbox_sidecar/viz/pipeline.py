"""The viz.analyze pipeline: decode → features → beats → harmony → sections → pitch → files."""

from __future__ import annotations

import os
import re
from typing import Any

import numpy as np

from ..registry import Context, HandlerError
from . import beats as beats_mod
from . import features as F
from . import harmony, io, pitch, sections

STEM_IDS = ("drums", "bass", "vocals", "other")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MIN_SEC = 1.0


def validate(params: dict[str, Any]) -> tuple[str, dict[str, str] | None, str, str, int | None]:
    path = params.get("path")
    if not isinstance(path, str) or not path:
        raise HandlerError("validation", "path is required")
    if not os.path.isfile(path):
        raise HandlerError("validation", "Input file not found", path)
    stems = params.get("stems")
    if stems is not None:
        if not isinstance(stems, dict):
            raise HandlerError("validation", "stems must be an object or null")
        for k in STEM_IDS:
            p = stems.get(k)
            if not isinstance(p, str) or not os.path.isfile(p):
                raise HandlerError("validation", f"Stem file for {k} not found")
        stems = {k: stems[k] for k in STEM_IDS}
    out_dir = params.get("outDir")
    if not isinstance(out_dir, str) or not out_dir:
        raise HandlerError("validation", "outDir is required")
    name = params.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise HandlerError("validation", "name must be a plain file name")
    fps = params.get("fps")
    if fps is not None and (isinstance(fps, bool) or not isinstance(fps, (int, float))):
        raise HandlerError("validation", "fps must be a number")
    return path, stems, out_dir, name, (int(fps) if fps is not None else None)


def _evt(env: np.ndarray, fps: int) -> list[list[int]]:
    return F.peak_events(env, fps)


def run(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path, stems, out_dir, name, req_fps = validate(params)

    ctx.stage("Reading the song")
    duration = io.probe_duration(path)
    if duration > io.MAX_SEC:
        raise HandlerError("validation", "Songs longer than 60 minutes can't be analysed", "Trim the file first.")
    fps = io.choose_fps(duration, req_fps)
    ctx.check_cancelled()

    y, stereo = io.decode(path, stereo=True)
    n = len(y)
    dur_sec = n / io.SR
    if dur_sec > io.MAX_SEC + 0.5:
        raise HandlerError("validation", "Songs longer than 60 minutes can't be analysed", "Trim the file first.")
    if dur_sec < MIN_SEC or float(np.max(np.abs(y), initial=0.0)) < 1e-4:
        raise HandlerError("validation", "Audio is too short or silent to analyse")
    fps = io.choose_fps(max(duration, dur_sec), req_fps)
    frames = F.n_frames(n, fps)
    hop = F.hop_for(fps)
    duration_ms = int(round(dur_sec * 1000))
    use_stems = stems is not None
    ctx.progress(0.06, "Reading the song")
    ctx.check_cancelled()

    grid = lambda x: F.to_grid(x, hop, frames, fps)  # noqa: E731
    scalars: dict[str, np.ndarray] = {}

    # -- the mix ---------------------------------------------------------------
    ctx.stage("Measuring the mix")
    mix = F.source_features(
        y, hop, F.MIX_BANDS + F.MIX_EXTRA, spectrum=True, centroid=True, check=ctx.check_cancelled,
        tick=lambda f: ctx.progress(0.06 + 0.22 * f),
    )
    scalars["mix.level"] = grid(F.level_channel(mix["rms"]))
    mix_onset_native = F.mel_onset(mix["mel"], hop)
    scalars["mix.onset"] = F.onset_norm(grid(mix_onset_native))
    scalars["mix.brightness"] = grid(F.brightness_channel(mix["centroid"]))
    if stereo is not None:
        lr, rr = F.stereo_rms(stereo, hop)
        scalars["mix.balance"] = F.smooth(grid(F.balance_channel(lr, rr)), 5)
        del lr, rr
    else:
        scalars["mix.balance"] = np.full(frames, 0.5, dtype=np.float32)
    del stereo
    for bname, _, _ in F.MIX_BANDS:
        scalars[f"mix.{bname}"] = grid(F.norm_db(mix["bands"][bname]))
    spectrum = grid(F.norm_db(mix["spec"]))
    low_env = F.onset_norm(grid(F.band_onset(mix["bands"]["low"])))
    mel_native = F.mel_db(mix["mel"])
    rms_raw = grid(mix["rms"])
    ctx.check_cancelled()
    ctx.progress(0.28, "Measuring the mix")

    wave = F.wave_block(y, hop, frames, fps)
    ctx.check_cancelled()

    # -- stems -------------------------------------------------------------------
    events: dict[str, list[list[int]]] = {}
    vocals_y = y
    vocals_rms_native: np.ndarray | None = None
    if stems is not None:
        for si, sid in enumerate(STEM_IDS):
            ctx.stage(f"Measuring {sid}")
            base = 0.28 + 0.22 * si / len(STEM_IDS)
            sy = io.fit_length(io.decode(stems[sid])[0], n)
            sf = F.source_features(
                sy, hop, F.DRUM_BANDS if sid == "drums" else [], check=ctx.check_cancelled,
                tick=lambda f, b=base: ctx.progress(b + 0.055 * f),
            )
            scalars[f"{sid}.level"] = grid(F.level_channel(sf["rms"]))
            scalars[f"{sid}.onset"] = F.onset_norm(grid(F.mel_onset(sf["mel"], hop)))
            if sid == "drums":
                for bname, _, _ in F.DRUM_BANDS:
                    scalars[f"drums.{bname}"] = F.onset_norm(grid(F.band_onset(sf["bands"][bname])))
            if sid == "vocals":
                vocals_y = sy
                vocals_rms_native = sf["rms"]
            ctx.check_cancelled()

    # -- beats ----------------------------------------------------------------------
    ctx.stage("Finding the beat")
    ctx.progress(0.5, "Finding the beat")
    tempo, beats_ms = beats_mod.track_beats(scalars["mix.onset"], fps)
    beats_ms = beats_ms[beats_ms < duration_ms]
    ctx.check_cancelled()

    # -- harmony ---------------------------------------------------------------------
    ctx.stage("Listening for chords")
    chroma = harmony.compute_chroma(y, io.SR)
    ctx.progress(0.62)
    ctx.check_cancelled()
    key = harmony.key_from_chroma(chroma)
    if len(beats_ms) >= 2:
        bc = harmony.beat_chroma(chroma, beats_ms, io.SR, duration_ms)
        chords, change, _ = harmony.decide_chords(bc, beats_ms, duration_ms)
    else:
        bc = np.zeros((12, 0), dtype=np.float32)
        chords, change = [], np.zeros(0, dtype=bool)

    kick_env = scalars["drums.kick"] if use_stems else low_env
    phase = beats_mod.downbeat_phase(beats_ms, kick_env, fps, change)
    downbeat_idx = np.arange(phase, len(beats_ms), beats_mod.BEATS_PER_BAR)
    downbeats_ms = beats_ms[downbeat_idx] if len(beats_ms) else np.zeros(0)
    ctx.check_cancelled()

    # -- sections -----------------------------------------------------------------------
    ctx.stage("Finding the sections")
    ctx.progress(0.66)
    loud = sections.bar_loudness(rms_raw, downbeats_ms, fps)
    ev_loud = sections.loudness_events(loud, downbeats_ms)
    bar_ms = float(np.median(np.diff(downbeats_ms))) if len(downbeats_ms) > 1 else 2000.0
    if len(beats_ms) >= 2:
        import librosa

        mfcc = librosa.feature.mfcc(S=mel_native, n_mfcc=13)
        nat_idx = np.rint(beats_ms / 1000.0 * io.SR / hop).astype(int)
        chr_idx = np.rint(beats_ms / 1000.0 * io.SR / harmony.CHROMA_HOP).astype(int)
        feat = np.vstack([sections.beat_sync(mfcc, nat_idx), sections.beat_sync(chroma, chr_idx)])
        z = sections.standardise(feat)
        forced = [int(np.argmin(np.abs(beats_ms - t))) for t, _ in ev_loud["drop"] + ev_loud["break"]]
        segs = sections.segment(z, len(beats_ms), dur_sec, downbeat_idx, forced)
        zvec = lambda a, b: z[:, a:b].mean(axis=1)  # noqa: E731
        secs = sections.build_sections(
            segs, beats_ms, zvec, scalars["mix.level"], fps,
            [t for t, _ in ev_loud["drop"]], bar_ms, float(duration_ms),
        )
    else:
        secs = [{"startMs": 0, "endMs": duration_ms, "label": "section", "group": "A", "energy": 0.5}]
    del mel_native
    ctx.check_cancelled()

    # -- pitch -----------------------------------------------------------------------------
    ctx.stage("Following the voice")
    ctx.progress(0.72)
    y16 = pitch.prepare_signal(vocals_y, io.SR, use_stems)
    midi, voiced = pitch.run_pyin(y16, check=ctx.check_cancelled)
    if vocals_rms_native is not None and len(voiced):
        g = F.to_grid(F.power_db(vocals_rms_native**2), hop, len(voiced), int(pitch.PYIN_FPS))
        voiced = voiced & (g > float(np.percentile(g, 99)) - 40.0)
    p_ch, v_ch, held = pitch.pitch_channels(midi, voiced, frames, fps)
    scalars["vocals.pitch"] = p_ch
    scalars["vocals.voiced"] = v_ch
    del y16, vocals_y
    ctx.check_cancelled()

    # -- events -----------------------------------------------------------------------------
    ctx.stage("Picking the hits")
    ctx.progress(0.92)
    band_env = lambda b: F.onset_norm(grid(F.band_onset(mix["bands"][b])))  # noqa: E731
    if use_stems:
        events["kick"] = _evt(scalars["drums.kick"], fps)
        events["snare"] = _evt(scalars["drums.snare"], fps)
        events["hats"] = _evt(scalars["drums.hats"], fps)
        events["bass"] = _evt(scalars["bass.onset"], fps)
        events["vocals"] = _evt(scalars["vocals.onset"], fps)
        events["other"] = _evt(scalars["other.onset"], fps)
    else:
        events["kick"] = _evt(low_env, fps)
        events["snare"] = _evt(band_env("mid"), fps)
        events["hats"] = _evt(band_env("brilliance"), fps)
        events["bass"] = _evt(band_env("bass"), fps)
        events["vocals"] = _evt(band_env("presence"), fps)
        events["other"] = _evt(band_env("highmid"), fps)
    events["mix"] = _evt(scalars["mix.onset"], fps)
    events["lift"] = ev_loud["lift"]
    events["drop"] = ev_loud["drop"]
    events["break"] = ev_loud["break"]
    held_events: list[list[int]] = held

    # -- write --------------------------------------------------------------------------------
    ctx.stage("Saving")
    order = [f"mix.{c}" for c in ("level", "onset", "brightness", "balance")] + [f"mix.{b}" for b, _, _ in F.MIX_BANDS]
    if use_stems:
        order += ["drums.level", "drums.onset", "drums.kick", "drums.snare", "drums.hats", "bass.level", "bass.onset",
                  "vocals.level", "vocals.onset", "other.level", "other.onset"]
    order += ["vocals.pitch", "vocals.voiced"]
    doc: dict[str, Any] = {
        "version": 1,
        "durationMs": duration_ms,
        "fps": fps,
        "frames": frames,
        "stems": use_stems,
        "tempo": tempo,
        "beatsPerBar": beats_mod.BEATS_PER_BAR,
        "beats": [int(round(t)) for t in beats_ms],
        "downbeats": [int(round(t)) for t in downbeats_ms],
        "key": {"name": key["name"], "camelot": key["camelot"], "minor": key["minor"]},
        "chords": chords,
        "sections": secs,
        "events": {**events, "held": held_events},
    }
    os.makedirs(out_dir, exist_ok=True)
    json_path, bin_path = io.write_outputs(
        out_dir, name, doc,
        [(cid, io.to_u8(scalars[cid])) for cid in order],
        [("spectrum", io.to_u8(spectrum)), ("wave", wave)],
    )
    ctx.progress(1.0, "Saving")
    return {
        "audioJson": json_path,
        "features": bin_path,
        "summary": {
            "durationMs": duration_ms,
            "tempo": tempo,
            "key": key["name"],
            "sections": [s["label"] for s in secs],
        },
    }
