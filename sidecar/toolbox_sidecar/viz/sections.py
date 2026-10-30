"""Sections, labels and loudness events: lift / drop / break (SPEC.md §5.3)."""

from __future__ import annotations

from typing import Any

import numpy as np

DROP_DB = 6.0
BREAK_DB = -6.0
LIFT_DB = 4.0
MIN_BARS = 4
GROUP_COS = 0.9


def bar_loudness(rms: np.ndarray, downbeats_ms: np.ndarray, fps: int) -> np.ndarray:
    """Mean loudness (dB) of each bar [downbeat k, downbeat k+1) from a linear RMS at the grid rate."""
    n = len(downbeats_ms)
    out = np.full(max(n - 1, 0), -90.0)
    power = rms.astype(np.float64) ** 2
    for k in range(n - 1):
        a = int(round(downbeats_ms[k] / 1000.0 * fps))
        b = max(a + 1, int(round(downbeats_ms[k + 1] / 1000.0 * fps)))
        seg = power[a:b]
        if seg.size:
            out[k] = 10.0 * np.log10(max(float(seg.mean()), 1e-9))
    return out


def loudness_events(loud: np.ndarray, downbeats_ms: np.ndarray) -> dict[str, list[list[int]]]:
    """drop: +6 dB vs the previous 2 bars; break: -6 dB; lift: ≥ 4 dB spread over the 2–4 bars before a downbeat."""
    ev: dict[str, list[list[int]]] = {"lift": [], "drop": [], "break": []}
    n = len(loud)
    cands: list[tuple[float, int]] = []
    for k in range(1, n):
        prev = loud[max(0, k - 2) : k]
        jump = float(loud[k] - prev.mean())
        t = int(round(downbeats_ms[k]))
        if jump >= DROP_DB:
            ev["drop"].append([t, int(round(min(1.0, max(0.5, jump / 12.0)) * 255))])
            continue
        if jump <= BREAK_DB:
            ev["break"].append([t, int(round(min(1.0, max(0.5, -jump / 12.0)) * 255))])
            continue
        if k < 2:
            continue
        best = 0.0
        for span in (2, 3, 4):
            if k - span < 0:
                break
            seg = loud[k - span : k]  # the bars before downbeat k
            rise = float(seg[-1] - seg[0])
            steps = np.diff(seg)
            if rise >= LIFT_DB and float(steps.min(initial=0.0)) >= -1.0 and float(steps.max(initial=0.0)) < DROP_DB:
                best = max(best, rise)
        if best >= LIFT_DB:
            cands.append((best, k))
    # Strongest ramps first; one lift per 4 bars.
    taken: list[int] = []
    for rise, k in sorted(cands, reverse=True):
        if all(abs(k - o) > 3 for o in taken):
            taken.append(k)
            ev["lift"].append([int(round(downbeats_ms[k])), int(round(min(1.0, rise / 10.0) * 255))])
    ev["lift"].sort()
    return ev


def beat_sync(feat: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Mean of feat columns between successive indices; idx are column indices (one per beat)."""
    n_c = feat.shape[1]
    out = np.zeros((feat.shape[0], len(idx)), dtype=np.float32)
    for i, a in enumerate(idx):
        b = idx[i + 1] if i + 1 < len(idx) else n_c
        a = int(np.clip(a, 0, n_c - 1))
        b = int(np.clip(b, a + 1, n_c))
        out[:, i] = feat[:, a:b].mean(axis=1)
    return out


def standardise(feat: np.ndarray) -> np.ndarray:
    return ((feat - feat.mean(axis=1, keepdims=True)) / (feat.std(axis=1, keepdims=True) + 1e-6)).astype(np.float32)


def _cos(a: np.ndarray, b: np.ndarray) -> float:
    d = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b) / d if d > 1e-12 else 0.0


def segment(
    feat: np.ndarray,
    n_beats: int,
    duration_sec: float,
    downbeat_idx: np.ndarray,
    forced_beats: list[int],
    bar_beats: int = 4,
) -> list[tuple[int, int]]:
    """Segments as beat-index ranges [a, b) from beat-synchronous features (rows = dimensions)."""
    import librosa

    if n_beats < 2 * MIN_BARS * bar_beats or feat.shape[1] < 2:
        return [(0, max(n_beats, 1))]
    z = feat  # already standardised (see standardise)
    k = int(np.clip(round(duration_sec / 20.0), 4, 12))
    k = min(k, n_beats // 2)
    bounds = [int(b) for b in np.asarray(librosa.segment.agglomerative(z, k)).tolist()]
    bounds += [int(b) for b in forced_beats]
    # Snap to the nearest downbeat, drop duplicates and the very start.
    snapped = set()
    for b in bounds:
        if downbeat_idx.size:
            b = int(downbeat_idx[int(np.argmin(np.abs(downbeat_idx - b)))])
        if 0 < b < n_beats:
            snapped.add(b)
    edges = [0] + sorted(snapped) + [n_beats]
    segs = [(edges[i], edges[i + 1]) for i in range(len(edges) - 1) if edges[i + 1] > edges[i]]

    def vec(s: tuple[int, int]) -> np.ndarray:
        return z[:, s[0] : s[1]].mean(axis=1)

    min_len = MIN_BARS * bar_beats
    while len(segs) > 1:
        short = [i for i, s in enumerate(segs) if s[1] - s[0] < min_len]
        if not short:
            break
        i = min(short, key=lambda j: segs[j][1] - segs[j][0])
        left = _cos(vec(segs[i]), vec(segs[i - 1])) if i > 0 else -2.0
        right = _cos(vec(segs[i]), vec(segs[i + 1])) if i + 1 < len(segs) else -2.0
        if left >= right:
            segs[i - 1 : i + 1] = [(segs[i - 1][0], segs[i][1])]
        else:
            segs[i : i + 2] = [(segs[i][0], segs[i + 1][1])]
    return segs


def groups(vecs: list[np.ndarray]) -> list[str]:
    """Greedy clustering: join the best centroid with cosine ≥ 0.9, else a new letter."""
    cents: list[list[np.ndarray]] = []
    names: list[str] = []
    for v in vecs:
        best, best_c = -1, GROUP_COS
        for gi, members in enumerate(cents):
            c = _cos(v, np.mean(members, axis=0))
            if c >= best_c:
                best, best_c = gi, c
        if best < 0:
            cents.append([v])
            best = len(cents) - 1
        else:
            cents[best].append(v)
        names.append(_letter(best))
    return names


def _letter(i: int) -> str:
    s = ""
    i += 1
    while i > 0:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def label_sections(
    starts_ms: list[float],
    ends_ms: list[float],
    group_names: list[str],
    energy: list[float],
    drop_ms: list[int],
    bar_ms: float,
    duration_ms: float,
) -> list[str]:
    n = len(starts_ms)
    labels: list[str | None] = [None] * n
    lengths = [e - s for s, e in zip(starts_ms, ends_ms)]
    if n > 1 and energy[0] < 0.45 and lengths[0] < 30000:
        labels[0] = "intro"
    if n > 1 and energy[-1] < 0.45 and lengths[-1] < 30000:
        labels[-1] = "outro"
    count: dict[str, int] = {}
    for g in group_names:
        count[g] = count.get(g, 0) + 1
    repeated = [g for g, c in count.items() if c >= 2]

    def gen(g: str) -> float:
        return float(np.mean([energy[i] for i in range(n) if group_names[i] == g]))

    chorus = max(repeated, key=gen, default=None)
    if chorus is not None:
        for i in range(n):
            if group_names[i] == chorus and labels[i] is None:
                labels[i] = "chorus"
    others = [g for g in repeated if g != chorus]
    verse = max(others, key=lambda g: (count[g], -group_names.index(g)), default=None)
    if verse is not None:
        for i in range(n):
            if group_names[i] == verse and labels[i] is None:
                labels[i] = "verse"
    for i in range(n):
        if labels[i] is None and count[group_names[i]] == 1 and starts_ms[i] >= duration_ms / 2:
            labels[i] = "bridge"
    for i in range(n):
        if labels[i] is None and any(abs(starts_ms[i] - d) <= bar_ms for d in drop_ms):
            labels[i] = "drop"
    return [lab or "section" for lab in labels]


def build_sections(
    segs: list[tuple[int, int]],
    beats_ms: np.ndarray,
    z_vec: Any,
    level: np.ndarray,
    fps: int,
    drops_ms: list[int],
    bar_ms: float,
    duration_ms: float,
) -> list[dict[str, Any]]:
    """Sections as schema dicts. z_vec(a, b) gives the mean feature vector of beats [a, b)."""
    starts = [0.0] + [float(beats_ms[a]) for a, _ in segs[1:]]
    ends = starts[1:] + [duration_ms]
    names = groups([z_vec(a, b) for a, b in segs])
    en = []
    for s, e in zip(starts, ends):
        a = int(round(s / 1000.0 * fps))
        b = max(a + 1, int(round(e / 1000.0 * fps)))
        en.append(float(level[a:b].mean()) if level[a:b].size else 0.0)
    lo, hi = min(en), max(en)
    energy = [(v - lo) / (hi - lo) if hi - lo > 1e-6 else 0.5 for v in en]
    labels = label_sections(starts, ends, names, energy, drops_ms, bar_ms, duration_ms)
    return [
        {
            "startMs": int(round(s)),
            "endMs": int(round(e)),
            "label": lab,
            "group": g,
            "energy": round(float(en_), 3),
        }
        for s, e, lab, g, en_ in zip(starts, ends, labels, names, energy)
    ]
