"""IoU tracker for video detections (SPEC.md §8.2). Pure: no I/O, no numpy needed.

A detection is ``(kind, x, y, w, h, score)`` with normalised coordinates.
``build_tracks`` takes the per-frame detections of a sampled video and returns
tracks whose ``hits`` are gap-filled, smoothed and extended, ready for the cache
file and for ``box_at`` interpolation.
"""

from __future__ import annotations

import bisect
import math
from typing import Any

IOU_MATCH = 0.3
CENTRE_MATCH = 0.5  # x the track box diagonal
END_GAP_MS = 500
EMA_ALPHA = 0.6
EXTEND_MS = 200
MIN_HITS = 3
KEEP_SCORE = 0.9
SAMPLE_MS = 200

Box = tuple[float, float, float, float]
Hit = tuple[int, Box, float]


def iou(a: Box, b: Box) -> float:
    iw = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    ih = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def _centre_ratio(a: Box, b: Box, aspect: float) -> float:
    """Centre distance divided by a's diagonal, measured in pixel proportions."""
    dx = ((a[0] + a[2] / 2) - (b[0] + b[2] / 2)) * aspect
    dy = (a[1] + a[3] / 2) - (b[1] + b[3] / 2)
    diag = math.hypot(a[2] * aspect, a[3])
    return math.hypot(dx, dy) / diag if diag > 0 else math.inf


class _Track:
    def __init__(self, kind: str, ms: int, box: Box, score: float) -> None:
        self.kind = kind
        self.hits: list[Hit] = [(ms, box, score)]

    @property
    def last(self) -> Hit:
        return self.hits[-1]


def build_tracks(
    frames: list[tuple[int, list[tuple[str, float, float, float, float, float]]]],
    *,
    aspect: float = 1.0,
    duration_ms: int | None = None,
    frame_ms: int | None = None,
) -> list[dict[str, Any]]:
    """frames: [(ms, detections)] in time order. Returns track dicts::

        {id, kind, hits: [{ms, x, y, w, h, score}], maxScore, enabled, nHits}

    aspect is frame width / height (so centre distances are measured in pixels).
    """
    if frame_ms is None:
        times = [t for t, _ in frames]
        frame_ms = round(min((b - a for a, b in zip(times, times[1:]) if b > a), default=67))
    active: list[_Track] = []
    done: list[_Track] = []
    for ms, dets in frames:
        still = []
        for t in active:
            (done if ms - t.last[0] > END_GAP_MS else still).append(t)
        active = still
        pairs = []
        for di, d in enumerate(dets):
            db: Box = (d[1], d[2], d[3], d[4])
            for ti, t in enumerate(active):
                if t.kind != d[0]:
                    continue
                tb = t.last[1]
                ov = iou(tb, db)
                if ov >= IOU_MATCH:
                    pairs.append((ov + 1.0, di, ti))  # IoU matches rank above distance matches
                else:
                    cr = _centre_ratio(tb, db, aspect)
                    if cr < CENTRE_MATCH:
                        pairs.append((1.0 - cr, di, ti))
        pairs.sort(reverse=True)
        used_d: set[int] = set()
        used_t: set[int] = set()
        for _, di, ti in pairs:
            if di in used_d or ti in used_t:
                continue
            used_d.add(di)
            used_t.add(ti)
            d = dets[di]
            active[ti].hits.append((ms, (d[1], d[2], d[3], d[4]), d[5]))
        for di, d in enumerate(dets):
            if di not in used_d:
                active.append(_Track(d[0], ms, (d[1], d[2], d[3], d[4]), d[5]))
    done.extend(active)
    done.sort(key=lambda t: t.hits[0][0])

    out = []
    for n, t in enumerate(done, 1):
        real = len(t.hits)
        max_score = max(h[2] for h in t.hits)
        hits = _extend(_smooth(_fill_gaps(t.hits, frame_ms)), duration_ms)
        out.append(
            {
                "id": f"t{n}",
                "kind": t.kind,
                "hits": [
                    {"ms": ms, "x": b[0], "y": b[1], "w": b[2], "h": b[3], "score": round(s, 4)} for ms, b, s in hits
                ],
                "maxScore": round(max_score, 4),
                "enabled": real >= MIN_HITS or max_score >= KEEP_SCORE,
                "nHits": real,
            }
        )
    return out


def _fill_gaps(hits: list[Hit], frame_ms: int) -> list[Hit]:
    """Linear interpolation at each missing sample time inside a gap."""
    out = [hits[0]]
    step = max(1, frame_ms)
    for cur in hits[1:]:
        prev = out[-1]
        gap = cur[0] - prev[0]
        if gap > step * 1.5:
            n = round(gap / step)
            for i in range(1, n):
                f = i / n
                box = tuple(a + (b - a) * f for a, b in zip(prev[1], cur[1]))
                out.append((prev[0] + round(gap * f), box, 0.0))  # type: ignore[arg-type]
        out.append(cur)
    return out


def _smooth(hits: list[Hit]) -> list[Hit]:
    out = [hits[0]]
    prev = hits[0][1]
    for ms, box, s in hits[1:]:
        prev = tuple(EMA_ALPHA * b + (1 - EMA_ALPHA) * p for b, p in zip(box, prev))  # type: ignore[assignment]
        out.append((ms, prev, s))
    return out


def _extend(hits: list[Hit], duration_ms: int | None) -> list[Hit]:
    first, last = hits[0], hits[-1]
    head = [(max(0, first[0] - EXTEND_MS), first[1], first[2])] if first[0] > 0 else []
    end = last[0] + EXTEND_MS
    if duration_ms is not None:
        end = min(end, max(duration_ms, last[0]))
    tail = [(end, last[1], last[2])] if end > last[0] else []
    return head + hits + tail


def box_at(hits: list[dict[str, Any]], ms: float) -> Box | None:
    """The track's box at time ms (linear between hits), or None outside its span."""
    if not hits or ms < hits[0]["ms"] or ms > hits[-1]["ms"]:
        return None
    times = [h["ms"] for h in hits]
    i = bisect.bisect_right(times, ms)
    if i >= len(hits):
        h = hits[-1]
        return (h["x"], h["y"], h["w"], h["h"])
    a, b = hits[i - 1], hits[i]
    span = b["ms"] - a["ms"]
    f = (ms - a["ms"]) / span if span > 0 else 0.0
    return tuple(a[k] + (b[k] - a[k]) * f for k in ("x", "y", "w", "h"))  # type: ignore[return-value]


def summarize(track: dict[str, Any]) -> dict[str, Any]:
    """The UI view of a track: span, max score, enabled, samples every 200 ms."""
    hits = track["hits"]
    start, end = hits[0]["ms"], hits[-1]["ms"]
    samples = []
    ms = start
    while True:
        t = min(ms, end)
        b = box_at(hits, t)
        if b is not None:
            samples.append({"ms": int(t), "x": b[0], "y": b[1], "w": b[2], "h": b[3]})
        if ms >= end:
            break
        ms += SAMPLE_MS
    return {
        "id": track["id"],
        "kind": track["kind"],
        "startMs": int(start),
        "endMs": int(end),
        "maxScore": track["maxScore"],
        "enabled": track["enabled"],
        "samples": samples,
    }
