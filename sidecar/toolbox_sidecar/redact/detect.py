"""Face (YuNet) and number-plate (YOLOv9-t) detection (SPEC.md §0.4, §8.2).

Everything here works on uint8 numpy arrays and returns boxes as
``(x1, y1, x2, y2, score)`` in the array's pixel coordinates; ``_wire`` turns
them into 0..1 ``(x, y, w, h)`` dicts for the wire.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

import numpy as np

from . import THRESHOLDS

PX = tuple[float, float, float, float, float]  # x1, y1, x2, y2, score

FACE_NMS = 0.3
PLATE_NMS = 0.5
YUNET_STRIDES = (8, 16, 32)
FACE_SCALE_SMALL = 640
FACE_SCALE_BIG = 1920
PLATE_SIZE = 640
PLATE_TILE_ABOVE = 1280  # images with a longer side are also run in 2x2 tiles
TILE_OVERLAP = 0.2
_PAD_COLOUR = 114

_sessions: dict[tuple[str, bool], Any] = {}
_lock = threading.Lock()


# -- ONNX dynamic-shape patch (no `onnx` package: edit the protobuf wire format) ------


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = val = 0
    while True:
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not b & 0x80:
            return val, i
        shift += 7


def _put_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _parse(buf: bytes) -> list[tuple[int, int, Any]]:
    """Protobuf message -> [(field, wire type, value)]; value is int (varint) or bytes."""
    out: list[tuple[int, int, Any]] = []
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        field, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(buf, i)
            out.append((field, wt, v))
        elif wt == 2:
            n, i = _varint(buf, i)
            out.append((field, wt, bytes(buf[i : i + n])))
            i += n
        elif wt == 1:
            out.append((field, wt, bytes(buf[i : i + 8])))
            i += 8
        elif wt == 5:
            out.append((field, wt, bytes(buf[i : i + 4])))
            i += 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wt}")
    return out


def _encode(fields: list[tuple[int, int, Any]]) -> bytes:
    out = bytearray()
    for field, wt, v in fields:
        out += _put_varint(field << 3 | wt)
        if wt == 0:
            out += _put_varint(v)
        elif wt == 2:
            out += _put_varint(len(v)) + v
        else:
            out += v
    return bytes(out)


def _dim_param(name: str) -> bytes:
    return _encode([(2, 2, name.encode())])


def _patch_value_info(buf: bytes, dynamic: dict[int, str]) -> bytes:
    """ValueInfoProto with tensor dims at the given indices turned into named symbols."""

    def edit_shape(shape: bytes) -> bytes:
        fields, n = [], 0
        for f, wt, v in _parse(shape):
            if f == 1:
                if n in dynamic:
                    v = _dim_param(dynamic[n])
                n += 1
            fields.append((f, wt, v))
        return _encode(fields)

    def edit_tensor(tensor: bytes) -> bytes:
        return _encode([(f, wt, edit_shape(v) if f == 2 else v) for f, wt, v in _parse(tensor)])

    def edit_type(tp: bytes) -> bytes:
        return _encode([(f, wt, edit_tensor(v) if f == 1 else v) for f, wt, v in _parse(tp)])

    return _encode([(f, wt, edit_type(v) if f == 2 else v) for f, wt, v in _parse(buf)])


def make_dynamic(model: bytes) -> bytes:
    """YuNet with free input H/W and free output lengths (cached shapes dropped)."""
    out = []
    for f, wt, v in _parse(model):
        if f != 7:
            out.append((f, wt, v))
            continue
        graph = []
        for gf, gwt, gv in _parse(v):
            if gf == 11:  # input: [1, 3, H, W]
                gv = _patch_value_info(gv, {2: "H", 3: "W"})
            elif gf == 12:  # output: [1, N, C]
                name = next((x.decode() for ff, _, x in _parse(gv) if ff == 1), "out")
                gv = _patch_value_info(gv, {1: "N_" + name})
            elif gf == 13:  # value_info holds the fixed intermediate shapes
                continue
            graph.append((gf, gwt, gv))
        out.append((f, wt, _encode(graph)))
    return _encode(out)


def session(path: str, dynamic: bool = False) -> Any:
    """A cached CPU onnxruntime session (the YuNet one is patched to dynamic shapes)."""
    key = (path, dynamic)
    with _lock:
        sess = _sessions.get(key)
        if sess is not None:
            return sess
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.log_severity_level = 3
        so.enable_cpu_mem_arena = False
        so.enable_mem_pattern = False
        with open(path, "rb") as f:
            data = f.read()
        if dynamic:
            data = make_dynamic(data)
        sess = ort.InferenceSession(data, so, providers=["CPUExecutionProvider"])
        _sessions[key] = sess
        return sess


# -- shared box helpers --------------------------------------------------------------


def nms(boxes: list[PX], thr: float) -> list[PX]:
    """Greedy IoU suppression, highest score first."""
    if not boxes:
        return []
    arr = np.asarray(boxes, dtype=np.float64)
    order = arr[:, 4].argsort()[::-1]
    area = (arr[:, 2] - arr[:, 0]).clip(0) * (arr[:, 3] - arr[:, 1]).clip(0)
    keep: list[int] = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        rest = order[1:]
        iw = (np.minimum(arr[i, 2], arr[rest, 2]) - np.maximum(arr[i, 0], arr[rest, 0])).clip(0)
        ih = (np.minimum(arr[i, 3], arr[rest, 3]) - np.maximum(arr[i, 1], arr[rest, 1])).clip(0)
        inter = iw * ih
        union = area[i] + area[rest] - inter
        iou = np.where(union > 0, inter / np.maximum(union, 1e-9), 0.0)
        order = rest[iou <= thr]
    return [tuple(float(v) for v in arr[i]) for i in keep]  # type: ignore[misc]


def clip_box(b: PX, w: int, h: int) -> PX | None:
    x1, y1, x2, y2 = max(0.0, b[0]), max(0.0, b[1]), min(float(w), b[2]), min(float(h), b[3])
    if x2 - x1 < 1 or y2 - y1 < 1:
        return None
    return (x1, y1, x2, y2, b[4])


def _resize(img: np.ndarray, w: int, h: int) -> np.ndarray:
    import cv2

    if (w, h) == (img.shape[1], img.shape[0]):
        return img
    shrink = w < img.shape[1] or h < img.shape[0]
    return cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA if shrink else cv2.INTER_LINEAR)


# -- faces ----------------------------------------------------------------------------


def decode_yunet(outs: list[np.ndarray], names: list[str], height: int, width: int, thr: float) -> list[PX]:
    """YuNet heads -> boxes (x1, y1, x2, y2, score) in the padded input's pixels, score >= thr."""
    o = dict(zip(names, outs, strict=True))
    found: list[PX] = []
    for st in YUNET_STRIDES:
        cols = width // st
        cls = np.clip(o[f"cls_{st}"][0, :, 0], 0, 1)
        obj = np.clip(o[f"obj_{st}"][0, :, 0], 0, 1)
        score = np.sqrt(cls * obj)
        sel = np.nonzero(score >= thr)[0]
        if sel.size == 0:
            continue
        bb = o[f"bbox_{st}"][0][sel]
        col = (sel % cols).astype(np.float32)
        row = (sel // cols).astype(np.float32)
        cx, cy = (col + bb[:, 0]) * st, (row + bb[:, 1]) * st
        bw, bh = np.exp(bb[:, 2]) * st, np.exp(bb[:, 3]) * st
        for k in range(sel.size):
            found.append(
                (
                    float(cx[k] - bw[k] / 2),
                    float(cy[k] - bh[k] / 2),
                    float(cx[k] + bw[k] / 2),
                    float(cy[k] + bh[k] / 2),
                    float(score[sel[k]]),
                )
            )
    return found


def faces_at_scale(sess: Any, bgr: np.ndarray, long_side: int, thr: float) -> list[PX]:
    """Runs YuNet on bgr scaled so its long side is long_side; boxes come back in bgr's pixels."""
    h, w = bgr.shape[:2]
    scale = long_side / max(h, w)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    small = _resize(bgr, nw, nh)
    ph, pw = -(-nh // 32) * 32, -(-nw // 32) * 32
    canvas = np.zeros((ph, pw, 3), np.float32)
    canvas[:nh, :nw] = small
    outs = sess.run(None, {"input": canvas.transpose(2, 0, 1)[None].copy()})
    names = [o.name for o in sess.get_outputs()]
    return [
        (b[0] / scale, b[1] / scale, b[2] / scale, b[3] / scale, b[4]) for b in decode_yunet(outs, names, ph, pw, thr)
    ]


def detect_faces(sess: Any, bgr: np.ndarray, thr: float, scales: tuple[int, ...]) -> list[PX]:
    h, w = bgr.shape[:2]
    found: list[PX] = []
    for s in dict.fromkeys(scales):  # distinct, in order
        found += faces_at_scale(sess, bgr, s, thr)
    return [c for b in nms(found, FACE_NMS) if (c := clip_box(b, w, h))]


# -- plates ---------------------------------------------------------------------------


def letterbox(rgb: np.ndarray, size: int) -> tuple[np.ndarray, float, int, int]:
    """Fit into size x size, centred on grey 114. Returns (canvas, ratio, left, top)."""
    import cv2

    h, w = rgb.shape[:2]
    r = min(size / w, size / h)
    nw, nh = max(1, round(w * r)), max(1, round(h * r))
    resized = _resize(rgb, nw, nh)
    left, top = max(0, int(round((size - nw) / 2 - 0.1))), max(0, int(round((size - nh) / 2 - 0.1)))
    canvas = cv2.copyMakeBorder(
        resized, top, size - nh - top, left, size - nw - left, cv2.BORDER_CONSTANT, value=(_PAD_COLOUR,) * 3
    )
    return canvas, r, left, top


def decode_plates(rows: np.ndarray, r: float, left: int, top: int, thr: float) -> list[PX]:
    """end2end rows [batch, x1, y1, x2, y2, class, score] in letterbox pixels -> source pixels."""
    out: list[PX] = []
    for row in np.asarray(rows).reshape(-1, 7):
        if float(row[6]) >= thr:
            out.append(
                (
                    (float(row[1]) - left) / r,
                    (float(row[2]) - top) / r,
                    (float(row[3]) - left) / r,
                    (float(row[4]) - top) / r,
                    float(row[6]),
                )
            )
    return out


def plates_once(sess: Any, rgb: np.ndarray, thr: float) -> list[PX]:
    canvas, r, left, top = letterbox(rgb, PLATE_SIZE)
    x = (canvas.astype(np.float32) / 255.0).transpose(2, 0, 1)[None].copy()
    rows = sess.run(None, {sess.get_inputs()[0].name: x})[0]
    return decode_plates(rows, r, left, top, thr)


def tile_rects(w: int, h: int, overlap: float = TILE_OVERLAP) -> list[tuple[int, int, int, int]]:
    """2x2 tiles (x0, y0, x1, y1) overlapping by `overlap` of a tile and covering the image."""
    tw, th = round(w / (2 - overlap)), round(h / (2 - overlap))
    xs, ys = [0, w - tw], [0, h - th]
    return [(x, y, x + tw, y + th) for y in ys for x in xs]


def detect_plates(
    sess: Any, rgb: np.ndarray, thr: float, tile: bool = True, check: Callable[[], None] | None = None
) -> list[PX]:
    h, w = rgb.shape[:2]
    found = plates_once(sess, rgb, thr)
    if tile and max(h, w) > PLATE_TILE_ABOVE:
        for x0, y0, x1, y1 in tile_rects(w, h):
            if check:
                check()
            for b in plates_once(sess, np.ascontiguousarray(rgb[y0:y1, x0:x1]), thr):
                found.append((b[0] + x0, b[1] + y0, b[2] + x0, b[3] + y0, b[4]))
    return [c for b in nms(found, PLATE_NMS) if (c := clip_box(b, w, h))]


# -- whole image ----------------------------------------------------------------------


def wire_boxes(kind: str, prefix: str, found: list[PX], w: int, h: int) -> list[dict[str, Any]]:
    """Pixel boxes -> wire dicts (0..1 of a w x h frame), left to right."""
    out = []
    for n, b in enumerate(sorted(found, key=lambda b: (b[0], b[1])), 1):
        out.append(
            {
                "id": f"{prefix}{n}",
                "x": b[0] / w,
                "y": b[1] / h,
                "w": (b[2] - b[0]) / w,
                "h": (b[3] - b[1]) / h,
                "kind": kind,
                "enabled": True,
                "score": round(b[4], 4),
            }
        )
    return out


def detect_image_array(
    rgb: np.ndarray,
    *,
    faces: bool,
    plates: bool,
    sensitivity: str,
    face_model: str | None,
    plate_model: str | None,
    check: Callable[[], None] | None = None,
) -> list[dict[str, Any]]:
    """rgb uint8 (H, W, 3) -> wire boxes (0..1 of this array), faces first then plates."""
    face_thr, plate_thr = THRESHOLDS[sensitivity]
    h, w = rgb.shape[:2]
    boxes: list[dict[str, Any]] = []
    if faces and face_model:
        bgr = np.ascontiguousarray(rgb[..., ::-1])
        scales = (FACE_SCALE_SMALL, min(FACE_SCALE_BIG, max(h, w)))
        found = detect_faces(session(face_model, dynamic=True), bgr, face_thr, scales)
        boxes += wire_boxes("face", "f", found, w, h)
    if check:
        check()
    if plates and plate_model:
        found = detect_plates(session(plate_model), rgb, plate_thr, check=check)
        boxes += wire_boxes("plate", "p", found, w, h)
    return boxes
