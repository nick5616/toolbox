"""ocr handlers: text recognition with RapidOCR (Phase 5 SPEC.md section 5).

The engine is always given explicit model paths and never self-downloads: the
bundled PP-OCRv6 small models come from the rapidocr wheel, other languages from
sha-verified downloads in ``modelDir`` (shared helper in ``download.py``).
"""

from __future__ import annotations

import json
import os
import statistics
from typing import Any

from ..download import ensure_model, validate_model_spec
from ..imageio import load_image, unique_path
from ..registry import Context, HandlerError, handler

IMAGE_OUTPUTS = ("text", "json")
PDF_OUTPUTS = ("searchable", "text", "both")
PREVIEW_CHARS = 2000
ENCRYPTED_MSG = "Remove this PDF's password first (PDF Toolkit → Remove password)"

# Recognition file prefix -> RapidOCR LangRec value (matters for Arabic bidi handling).
_REC_LANGS = {
    "cyrillic": "cyrillic",
    "arabic": "arabic",
    "korean": "korean",
    "el": "el",
    "th": "th",
    "devanagari": "devanagari",
}

# One resident engine: (det path, rec path, lang) -> RapidOCR.
_engine: tuple[tuple[str, str, str], Any] | None = None


# -- pure functions ----------------------------------------------------------------


def _bounds(box: list[list[float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    return min(xs), min(ys), max(xs), max(ys)


def sort_lines(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reading order: top to bottom; lines whose vertical centres fall within half a
    line height of each other form a row and are ordered left to right."""
    items = []
    for ln in lines:
        x0, y0, x1, y1 = _bounds(ln["box"])
        items.append((ln, x0, (y0 + y1) / 2, max(y1 - y0, 1.0)))
    items.sort(key=lambda t: t[2])
    rows: list[list[tuple[dict[str, Any], float, float, float]]] = []
    for it in items:
        if rows:
            ref_cy = statistics.fmean(r[2] for r in rows[-1])
            ref_h = min(r[3] for r in rows[-1])
            if abs(it[2] - ref_cy) <= 0.5 * min(it[3], ref_h):
                rows[-1].append(it)
                continue
        rows.append([it])
    out: list[dict[str, Any]] = []
    for row in rows:
        row.sort(key=lambda t: t[1])
        out.extend(t[0] for t in row)
    return out


def lines_to_text(lines: list[dict[str, Any]]) -> str:
    """Lines joined with a newline; a blank line where the vertical gap is large (a new block)."""
    if not lines:
        return ""
    heights = [max(_bounds(ln["box"])[3] - _bounds(ln["box"])[1], 1.0) for ln in lines]
    med = statistics.median(heights)
    parts: list[str] = []
    prev_bottom = None
    for ln in lines:
        _x0, y0, _x1, y1 = _bounds(ln["box"])
        if prev_bottom is not None and y0 - prev_bottom > 0.8 * med:
            parts.append("")
        parts.append(ln["text"])
        prev_bottom = y1 if prev_bottom is None or y0 > prev_bottom else max(prev_bottom, y1)
    return "\n".join(parts)


def result_to_lines(res: Any) -> list[dict[str, Any]]:
    """RapidOCR output -> [{text, confidence, box, words:[{text, box}]}] (unsorted)."""
    txts = list(getattr(res, "txts", None) or [])
    if not txts:
        return []
    scores = list(getattr(res, "scores", None) or [1.0] * len(txts))
    boxes = getattr(res, "boxes", None)
    wr = getattr(res, "word_results", None) or []
    lines: list[dict[str, Any]] = []
    for i, text in enumerate(txts):
        words = []
        if i < len(wr):
            for w in wr[i]:
                words.append({"text": w[0], "box": [[float(a), float(b)] for a, b in w[2]]})
        box = [[float(a), float(b)] for a, b in boxes[i]] if boxes is not None and i < len(boxes) else None
        if box is None and words:
            x0 = min(_bounds(w["box"])[0] for w in words)
            y0 = min(_bounds(w["box"])[1] for w in words)
            x1 = max(_bounds(w["box"])[2] for w in words)
            y1 = max(_bounds(w["box"])[3] for w in words)
            box = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        if box is None:
            continue
        if not words:
            words = [{"text": text, "box": box}]
        lines.append({"text": text, "confidence": float(scores[i]), "box": box, "words": words})
    return lines


def to_json_doc(lines: list[dict[str, Any]], width: int, height: int) -> dict[str, Any]:
    return {
        "width": width,
        "height": height,
        "lines": [
            {
                "text": ln["text"],
                "confidence": ln["confidence"],
                "box": ln["box"],
                "words": [{"text": w["text"], "box": w["box"]} for w in ln["words"]],
            }
            for ln in lines
        ],
    }


def pdf_lines(lines: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Lines -> [[{"t","q"}]] for the PDF overlay."""
    return [[{"t": w["text"], "q": w["box"]} for w in ln["words"]] for ln in lines]


def mean_conf(lines: list[dict[str, Any]]) -> float:
    return float(statistics.fmean(ln["confidence"] for ln in lines)) if lines else 0.0


def rec_lang(file: str) -> str:
    prefix = file.split("_", 1)[0]
    return _REC_LANGS.get(prefix, "ch")


# -- engine -------------------------------------------------------------------------


def _bundled_dir() -> str:
    import rapidocr

    return os.path.join(os.path.dirname(rapidocr.__file__), "models")


def build_params(det: str | None, rec: str | None, lang: str, model_dir: str) -> dict[str, Any]:
    """RapidOCR params with explicit model paths (None = the bundled v6 small models)."""
    from rapidocr import LangRec, ModelType, OCRVersion

    bundled = _bundled_dir()
    p: dict[str, Any] = {
        "Global.log_level": "warning",
        "Global.return_word_box": True,
        "Global.model_root_dir": model_dir,
        "Cls.model_path": os.path.join(bundled, "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
    }
    if det is None:
        p["Det.model_path"] = os.path.join(bundled, "PP-OCRv6_det_small.onnx")
    else:
        p.update({"Det.model_path": det, "Det.ocr_version": OCRVersion.PPOCRV5, "Det.model_type": ModelType.MOBILE})
    if rec is None:
        p["Rec.model_path"] = os.path.join(bundled, "PP-OCRv6_rec_small.onnx")
    else:
        p.update(
            {
                "Rec.model_path": rec,
                "Rec.ocr_version": OCRVersion.PPOCRV5,
                "Rec.model_type": ModelType.MOBILE,
                "Rec.lang_type": LangRec(lang),
            }
        )
    return p


def _get_engine(det: str | None, rec: str | None, lang: str, model_dir: str) -> Any:
    global _engine
    key = (det or "", rec or "", lang)
    if _engine is not None and _engine[0] == key:
        return _engine[1]
    _engine = None  # free the previous models first
    from rapidocr import RapidOCR

    eng = RapidOCR(params=build_params(det, rec, lang, model_dir))
    _engine = (key, eng)
    return eng


def recognize(engine: Any, rgb: Any) -> list[dict[str, Any]]:
    """Runs the engine on an RGB ndarray and returns sorted lines."""
    try:
        res = engine(rgb)
    except Exception as e:  # noqa: BLE001
        raise HandlerError("tool_failed", f"Text recognition failed: {e}") from e
    return sort_lines(result_to_lines(res))


# -- params -------------------------------------------------------------------------


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


def _base_name(params: dict[str, Any], path: str) -> str:
    base = params.get("baseName") or os.path.splitext(os.path.basename(path))[0]
    if not isinstance(base, str) or not base.strip() or os.path.basename(base) != base:
        raise HandlerError("validation", "baseName must be a plain file name")
    return base


def _models(ctx: Context, params: dict[str, Any]) -> tuple[str | None, str | None, str, str]:
    """Validates det/rec (null = bundled) and ensures the files. Returns (det, rec, lang, modelDir)."""
    model_dir = _str(params, "modelDir")
    specs = {}
    for key in ("det", "rec"):
        v = params.get(key)
        specs[key] = None if v is None else validate_model_spec(v)
    det = rec = None
    lang = "ch"
    if specs["det"]:
        s = specs["det"]
        det = ensure_model(ctx, model_dir, s["file"], s["sha256"], s["url"])
        ctx.check_cancelled()
    if specs["rec"]:
        s = specs["rec"]
        rec = ensure_model(ctx, model_dir, s["file"], s["sha256"], s["url"])
        lang = rec_lang(s["file"])
        ctx.check_cancelled()
    return det, rec, lang, model_dir


def _write_text(directory: str, base: str, ext: str, content: str) -> str:
    os.makedirs(directory, exist_ok=True)
    while True:
        path = unique_path(directory, base, ext)
        try:
            f = open(path, "x", encoding="utf-8", newline="\n")
        except FileExistsError:
            continue
        with f:
            f.write(content)
        return path


def _load_rgb(path: str) -> Any:
    import numpy as np

    return np.asarray(load_image(path).convert("RGB"))


# -- handlers -----------------------------------------------------------------------


@handler("ocr.image")
def ocr_image(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path = _str(params, "input")
    if not os.path.isfile(path):
        raise HandlerError("validation", "Input file not found", path)
    out_dir = os.path.abspath(_str(params, "outputDir"))
    base = _base_name(params, path)
    output = params.get("output", "text")
    if output not in IMAGE_OUTPUTS:
        raise HandlerError("validation", "output must be text or json")
    det, rec, lang, model_dir = _models(ctx, params)

    ctx.stage("Loading models")
    try:
        eng = _get_engine(det, rec, lang, model_dir)
    except Exception as e:  # noqa: BLE001
        raise HandlerError("tool_failed", f"Couldn't load the OCR models: {e}", "Delete the model files to download them again") from e
    ctx.check_cancelled()
    rgb = _load_rgb(path)
    h, w = rgb.shape[:2]
    ctx.check_cancelled()

    ctx.stage("Reading text")
    lines = recognize(eng, rgb)
    ctx.check_cancelled()
    text = lines_to_text(lines)

    ctx.stage("Saving")
    if output == "json":
        saved = _write_text(out_dir, f"{base} (text)", "json", json.dumps(to_json_doc(lines, w, h), ensure_ascii=False, indent=2))
    else:
        saved = _write_text(out_dir, f"{base} (text)", "txt", text + ("\n" if text else ""))
    ctx.output(saved)
    return {
        "lines": len(lines),
        "characters": sum(len(ln["text"]) for ln in lines),
        "meanConfidence": mean_conf(lines),
        "output": saved,
        "preview": text[:PREVIEW_CHARS],
    }


def _validate_pages(params: dict[str, Any]) -> list[dict[str, Any]]:
    pages = params.get("pages")
    if not isinstance(pages, list) or not pages:
        raise HandlerError("validation", "pages is required")
    out = []
    for p in pages:
        if not isinstance(p, dict):
            raise HandlerError("validation", "pages entries must be objects")
        n = p.get("page")
        if isinstance(n, bool) or not isinstance(n, int) or n < 1:
            raise HandlerError("validation", "page numbers start at 1")
        skip = p.get("skip", False)
        if not isinstance(skip, bool):
            raise HandlerError("validation", "skip must be a boolean")
        png = p.get("png")
        if not skip and (not isinstance(png, str) or not os.path.isfile(png)):
            raise HandlerError("validation", f"Rendered image for page {n} is missing")
        out.append({"page": n, "png": png, "skip": skip})
    return out


@handler("ocr.pdf")
def ocr_pdf(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    from .. import pdftext

    path = _str(params, "input")
    if not os.path.isfile(path):
        raise HandlerError("validation", "Input file not found", path)
    out_dir = os.path.abspath(_str(params, "outputDir"))
    base = _base_name(params, path)
    pdf_output = params.get("pdfOutput", "searchable")
    if pdf_output not in PDF_OUTPUTS:
        raise HandlerError("validation", "pdfOutput must be searchable, text or both")
    dpi = params.get("dpi", 200)
    if isinstance(dpi, bool) or not isinstance(dpi, int) or not 36 <= dpi <= 600:
        raise HandlerError("validation", "dpi must be an integer from 36 to 600")
    pages = _validate_pages(params)
    try:
        if pdftext.is_encrypted(path):
            raise HandlerError("validation", ENCRYPTED_MSG)
    except HandlerError:
        raise
    except Exception as e:  # noqa: BLE001
        raise HandlerError("validation", "This PDF is damaged or can't be read", str(e)) from e
    det, rec, lang, model_dir = _models(ctx, params)

    todo = [p for p in pages if not p["skip"]]
    texts: dict[int, str] = {}
    overlay_pages: dict[int, dict[str, Any]] = {}
    confidences: list[float] = []
    if todo:
        ctx.stage("Loading models")
        try:
            eng = _get_engine(det, rec, lang, model_dir)
        except Exception as e:  # noqa: BLE001
            raise HandlerError("tool_failed", f"Couldn't load the OCR models: {e}", "Delete the model files to download them again") from e
    total = len(pages)
    for n, p in enumerate(todo):
        ctx.check_cancelled()
        ctx.progress(n / len(todo), f"Reading page {p['page']} of {total}", force=True)
        lines = recognize(eng, _load_rgb(p["png"]))
        idx = p["page"] - 1
        texts[idx] = lines_to_text(lines)
        confidences.extend(ln["confidence"] for ln in lines)
        overlay_pages[idx] = {"scale": dpi / 72.0, "lines": pdf_lines(lines)}
    ctx.check_cancelled()

    skipped = [p["page"] - 1 for p in pages if p["skip"]]
    try:
        texts.update(pdftext.page_texts(path, skipped))
    except Exception:  # noqa: BLE001
        pass

    outputs: list[str] = []
    os.makedirs(out_dir, exist_ok=True)
    if pdf_output in ("searchable", "both"):
        ctx.stage("Writing searchable PDF")
        dst = unique_path(out_dir, f"{base} (searchable)", "pdf")
        part = dst + ".part"
        try:
            pdftext.overlay(path, part, overlay_pages)
            os.replace(part, dst)
        except pdftext.EncryptedPDF as e:
            raise HandlerError("validation", ENCRYPTED_MSG) from e
        except HandlerError:
            raise
        except Exception as e:  # noqa: BLE001
            raise HandlerError("tool_failed", f"Couldn't write the searchable PDF: {e}") from e
        finally:
            try:
                os.remove(part)
            except OSError:
                pass
        outputs.append(dst)
        ctx.output(dst)
    ordered = [texts.get(p["page"] - 1, "") for p in pages]
    if pdf_output in ("text", "both"):
        ctx.stage("Writing text")
        saved = _write_text(out_dir, f"{base} (text)", "txt", "\f".join(ordered))
        outputs.append(saved)
        ctx.output(saved)
    return {
        "pages": total,
        "pagesOcred": len(todo),
        "pagesSkipped": total - len(todo),
        "characters": sum(len(t.replace("\n", "")) for t in ordered),
        "meanConfidence": float(statistics.fmean(confidences)) if confidences else 0.0,
        "outputs": outputs,
    }
