"""ocr handlers: line sorting, writers, model selection, cancellation, validation (fake engine) + a slow real run."""

from __future__ import annotations

import json
import os
from types import SimpleNamespace

import pytest
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter

from toolbox_sidecar.handlers import ocr
from toolbox_sidecar.registry import Cancelled, HandlerError


def quad(x, y, w=100, h=20):
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def line(text, x, y, w=100, h=20, conf=0.9):
    return {"text": text, "confidence": conf, "box": quad(x, y, w, h), "words": [{"text": text, "box": quad(x, y, w, h)}]}


def fake_result(items):
    """items: [(text, x, y, w)] -> an object shaped like RapidOCR's output (one word per line)."""
    boxes = [quad(x, y, w, 20) for _t, x, y, w in items]
    return SimpleNamespace(
        txts=tuple(t for t, *_ in items),
        scores=tuple(0.9 for _ in items),
        boxes=boxes,
        word_results=[((t, 0.9, quad(x, y, w, 20)),) for t, x, y, w in items],
    )


class FakeEngine:
    def __init__(self, items, on_call=None):
        self.items, self.calls, self.on_call = items, 0, on_call

    def __call__(self, rgb):
        self.calls += 1
        if self.on_call:
            self.on_call(self.calls)
        return fake_result(self.items)


# -- pure functions -----------------------------------------------------------------


def test_sort_lines_rows_left_to_right_then_top_to_bottom():
    a, b, c, d = line("d-bottom", 10, 300), line("b-right", 400, 102), line("a-left", 10, 100), line("c-mid", 10, 200)
    assert [x["text"] for x in ocr.sort_lines([a, b, c, d])] == ["a-left", "b-right", "c-mid", "d-bottom"]


def test_lines_to_text_blank_line_between_blocks():
    lines = [line("one", 0, 0), line("two", 0, 25), line("three", 0, 200)]
    assert ocr.lines_to_text(lines) == "one\ntwo\n\nthree"
    assert ocr.lines_to_text([]) == ""


def test_result_to_lines_and_empty():
    r = fake_result([("hi", 5, 6, 40)])
    ln = ocr.result_to_lines(r)[0]
    assert ln["text"] == "hi" and ln["words"][0]["text"] == "hi" and ln["box"][0] == [5.0, 6.0]
    assert ocr.result_to_lines(SimpleNamespace(txts=None, scores=None, boxes=None, word_results=None)) == []


def test_model_selection():
    p = ocr.build_params(None, None, "ch", "/m")
    assert p["Det.model_path"].endswith("PP-OCRv6_det_small.onnx") and os.path.isfile(p["Det.model_path"])
    assert os.path.isfile(p["Rec.model_path"]) and os.path.isfile(p["Cls.model_path"])
    assert "Rec.lang_type" not in p and p["Global.return_word_box"] is True
    q = ocr.build_params("/m/det.onnx", "/m/rec.onnx", "cyrillic", "/m")
    assert q["Det.model_path"] == "/m/det.onnx" and q["Rec.model_path"] == "/m/rec.onnx"
    assert q["Rec.lang_type"].value == "cyrillic"
    assert ocr.rec_lang("arabic_PP-OCRv5_rec_mobile.onnx") == "arabic"
    assert ocr.rec_lang("el_PP-OCRv5_rec_mobile.onnx") == "el"


# -- ocr.image ----------------------------------------------------------------------


@pytest.fixture
def png(tmp_path):
    p = tmp_path / "scan.png"
    Image.new("RGB", (200, 100), "white").save(p)
    return str(p)


def _img_params(tmp_path, png, **kw):
    p = {"input": png, "outputDir": str(tmp_path / "out"), "modelDir": str(tmp_path / "m"), "det": None, "rec": None}
    p.update(kw)
    return p


def test_image_text_and_json_outputs(tmp_path, cap, png, monkeypatch):
    eng = FakeEngine([("second", 10, 60, 80), ("first", 10, 10, 60), ("right", 120, 12, 50)])
    monkeypatch.setattr(ocr, "_get_engine", lambda *a: eng)
    res = ocr.ocr_image(cap.ctx, _img_params(tmp_path, png, baseName="scan"))
    assert res["lines"] == 3 and res["characters"] == len("second" + "first" + "right")
    assert res["preview"].startswith("first\nright\nsecond") or res["preview"].startswith("first")
    assert os.path.basename(res["output"]) == "scan (text).txt"
    assert open(res["output"], encoding="utf-8").read().splitlines()[:2] == ["first", "right"]
    assert cap.events("output") == [{"path": res["output"]}]

    res2 = ocr.ocr_image(cap.ctx, _img_params(tmp_path, png, baseName="scan", output="json"))
    doc = json.load(open(res2["output"], encoding="utf-8"))
    assert doc["width"] == 200 and doc["height"] == 100 and len(doc["lines"]) == 3
    assert doc["lines"][0]["text"] == "first" and doc["lines"][0]["words"][0]["box"][0] == [10.0, 10.0]
    # never overwrites an existing result
    res3 = ocr.ocr_image(cap.ctx, _img_params(tmp_path, png, baseName="scan"))
    assert os.path.basename(res3["output"]) == "scan (text) (1).txt"


def test_image_preview_limited(tmp_path, cap, png, monkeypatch):
    long = "x" * 3000
    monkeypatch.setattr(ocr, "_get_engine", lambda *a: FakeEngine([(long, 0, 0, 90)]))
    assert len(ocr.ocr_image(cap.ctx, _img_params(tmp_path, png))["preview"]) == ocr.PREVIEW_CHARS


def test_image_validation(tmp_path, cap, png):
    for bad, msg in [
        ({"input": str(tmp_path / "nope.png")}, "not found"),
        ({"output": "html"}, "text or json"),
        ({"baseName": "../x"}, "plain file name"),
        ({"modelDir": ""}, "modelDir"),
        ({"rec": {"file": "x"}}, "model."),
    ]:
        with pytest.raises(HandlerError) as e:
            ocr.ocr_image(cap.ctx, _img_params(tmp_path, png, **bad))
        assert e.value.code == "validation" and msg in e.value.message


def test_models_downloaded_via_shared_helper(tmp_path, cap, png, monkeypatch):
    calls = []

    def fake_ensure(ctx, model_dir, file, sha, url):
        calls.append((model_dir, file, sha, url))
        return os.path.join(model_dir, file)

    seen = {}

    def fake_engine(det, rec, lang, model_dir):
        seen.update(det=det, rec=rec, lang=lang)
        return FakeEngine([("ok", 1, 1, 30)])

    monkeypatch.setattr(ocr, "ensure_model", fake_ensure)
    monkeypatch.setattr(ocr, "_get_engine", fake_engine)
    det = {"file": "ch_PP-OCRv5_det_mobile.onnx", "sha256": "a" * 64, "url": "https://x/d"}
    rec = {"file": "cyrillic_PP-OCRv5_rec_mobile.onnx", "sha256": "b" * 64, "url": "https://x/r"}
    ocr.ocr_image(cap.ctx, _img_params(tmp_path, png, det=det, rec=rec))
    assert [c[1] for c in calls] == [det["file"], rec["file"]]
    assert seen["lang"] == "cyrillic" and seen["rec"].endswith(rec["file"])


# -- ocr.pdf ------------------------------------------------------------------------


def _pdf(tmp_path, pages=3, name="in.pdf"):
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(300, 300)
    p = tmp_path / name
    with open(p, "wb") as f:
        w.write(f)
    return str(p)


def _pdf_params(tmp_path, src, npages, **kw):
    pngs = []
    for i in range(1, npages + 1):
        p = tmp_path / f"p{i:04d}.png"
        Image.new("RGB", (100, 100), "white").save(p)
        pngs.append({"page": i, "png": str(p), "skip": False})
    p = {"input": src, "pages": pngs, "dpi": 200, "outputDir": str(tmp_path / "out"), "modelDir": str(tmp_path / "m"),
         "det": None, "rec": None, "pdfOutput": "searchable", "baseName": "doc"}
    p.update(kw)
    return p


def test_pdf_searchable_and_text(tmp_path, cap, monkeypatch):
    src = _pdf(tmp_path)
    params = _pdf_params(tmp_path, src, 3, pdfOutput="both")
    params["pages"][1]["skip"] = True
    monkeypatch.setattr(ocr, "_get_engine", lambda *a: FakeEngine([("hello", 100, 100, 200)]))
    res = ocr.ocr_pdf(cap.ctx, params)
    assert (res["pages"], res["pagesOcred"], res["pagesSkipped"]) == (3, 2, 1)
    pdf_out = [o for o in res["outputs"] if o.endswith("(searchable).pdf")][0]
    txt_out = [o for o in res["outputs"] if o.endswith("(text).txt")][0]
    r = PdfReader(pdf_out)
    assert "hello" in r.pages[0].extract_text() and "hello" not in r.pages[1].extract_text() and "hello" in r.pages[2].extract_text()
    assert open(txt_out, encoding="utf-8").read() == "hello\f\fhello"
    assert res["characters"] == 10 and res["meanConfidence"] == pytest.approx(0.9)
    assert [e["path"] for e in cap.events("output")] == res["outputs"]
    assert any("Reading page 3 of 3" in (e.get("msg") or "") for e in cap.events("progress"))


def test_pdf_text_only_writes_no_pdf(tmp_path, cap, monkeypatch):
    src = _pdf(tmp_path, 1)
    monkeypatch.setattr(ocr, "_get_engine", lambda *a: FakeEngine([("a", 1, 1, 20)]))
    res = ocr.ocr_pdf(cap.ctx, _pdf_params(tmp_path, src, 1, pdfOutput="text"))
    assert len(res["outputs"]) == 1 and res["outputs"][0].endswith("(text).txt")


def test_pdf_cancel_between_pages(tmp_path, cap, monkeypatch):
    src = _pdf(tmp_path)
    eng = FakeEngine([("a", 1, 1, 20)], on_call=lambda n: cap.ctx.request_cancel() if n == 1 else None)
    monkeypatch.setattr(ocr, "_get_engine", lambda *a: eng)
    with pytest.raises(Cancelled):
        ocr.ocr_pdf(cap.ctx, _pdf_params(tmp_path, src, 3))
    assert eng.calls == 1
    assert not os.path.isdir(tmp_path / "out") or not os.listdir(tmp_path / "out")


def test_pdf_encrypted_message(tmp_path, cap):
    w = PdfWriter(clone_from=PdfReader(_pdf(tmp_path, 1)))
    w.encrypt("pw")
    enc = tmp_path / "enc.pdf"
    with open(enc, "wb") as f:
        w.write(f)
    with pytest.raises(HandlerError) as e:
        ocr.ocr_pdf(cap.ctx, _pdf_params(tmp_path, str(enc), 1))
    assert e.value.code == "validation"
    assert e.value.message == "Remove this PDF's password first (PDF Toolkit → Remove password)"


def test_pdf_validation(tmp_path, cap):
    src = _pdf(tmp_path, 1)
    for bad, msg in [
        ({"pdfOutput": "docx"}, "pdfOutput"),
        ({"dpi": 5}, "dpi"),
        ({"pages": []}, "pages"),
        ({"pages": [{"page": 0, "png": "x", "skip": True}]}, "start at 1"),
        ({"pages": [{"page": 1, "png": str(tmp_path / "missing.png"), "skip": False}]}, "missing"),
    ]:
        with pytest.raises(HandlerError) as e:
            ocr.ocr_pdf(cap.ctx, _pdf_params(tmp_path, src, 1, **bad))
        assert e.value.code == "validation" and msg in e.value.message


# -- slow: real RapidOCR ------------------------------------------------------------


@pytest.mark.slow
def test_real_rapidocr_on_rendered_text(tmp_path, cap):
    im = Image.new("RGB", (900, 220), "white")
    d = ImageDraw.Draw(im)
    font = ImageFont.load_default(size=64)
    d.text((30, 20), "Toolbox OCR 2026", fill="black", font=font)
    d.text((30, 120), "Hello searchable world", fill="black", font=font)
    src = tmp_path / "text.png"
    im.save(src)
    res = ocr.ocr_image(cap.ctx, {"input": str(src), "outputDir": str(tmp_path / "o"), "modelDir": str(tmp_path / "m"), "det": None, "rec": None})
    text = open(res["output"], encoding="utf-8").read()
    assert "Toolbox OCR 2026" in text and "searchable" in text
    assert res["meanConfidence"] > 0.8
