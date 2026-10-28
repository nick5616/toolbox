"""pdftext: the invisible text overlay on generated PDFs (rotation, cropbox, byte-identical originals)."""

from __future__ import annotations

import io

import pytest
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject

from toolbox_sidecar import pdftext

SCALE = 200 / 72
CROP = (20.0, 30.0, 500.0, 700.0)  # x0, y0, x1, y1 on a 612x792 media box


def _make_pdf(path, rotate=0, crop=True, text_stream=b"0.5 g 50 50 200 100 re f"):
    w = PdfWriter()
    page = w.add_blank_page(612, 792)
    cs = DecodedStreamObject()
    cs.set_data(text_stream)
    page[NameObject("/Contents")] = w._add_object(cs)
    if crop:
        page[NameObject("/CropBox")] = ArrayObject([FloatObject(v) for v in CROP])
    if rotate:
        page[NameObject("/Rotate")] = NumberObject(rotate)
    w.add_metadata({"/Title": "Original title"})
    w.add_outline_item("Chapter", 0)
    with open(path, "wb") as f:
        w.write(f)
    return str(path)


def _quad(x, y, w, h):
    """Axis-aligned word quad (tl, tr, br, bl) in render pixels."""
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def _view_of(x, y, rot, box=CROP):
    """User-space point -> view coords in pt from the top-left of the displayed page (forward map)."""
    x0, y0, x1, y1 = box
    return {0: (x - x0, y1 - y), 90: (y - y0, x - x0), 180: (x1 - x, y - y0), 270: (y1 - y, x1 - x)}[rot]


def _extract(path):
    out = []

    def visit(text, cm, tm, font_dict, font_size):
        if text.strip():
            out.append((text, tm[4], tm[5]))

    PdfReader(path).pages[0].extract_text(visitor_text=visit)
    return out


LINES = [[{"t": "hello", "q": _quad(300, 400, 220, 40)}], [{"t": "world", "q": _quad(560, 900, 240, 40)}]]


@pytest.mark.parametrize("rot", [0, 90, 180, 270])
def test_overlay_places_words_for_each_rotation_and_cropbox(tmp_path, rot):
    src = _make_pdf(tmp_path / "in.pdf", rotate=rot)
    dst = str(tmp_path / "out.pdf")
    n = pdftext.overlay(src, dst, {0: {"scale": SCALE, "lines": LINES}})
    assert n == 2
    got = _extract(dst)
    assert [g[0].strip() for g in got] == ["hello", "world"]
    for (text, x, y), word in zip(got, [ln[0] for ln in LINES]):
        # origin = bottom-left of the word quad
        qx, qy = word["q"][3]
        u, v = _view_of(x, y, rot)
        assert u == pytest.approx(qx / SCALE, abs=0.5)
        assert v == pytest.approx(qy / SCALE, abs=0.5)
    assert "hello world" in PdfReader(dst).pages[0].extract_text().replace("\n", " ")


def test_original_streams_and_images_unchanged(tmp_path):
    img = Image.new("RGB", (64, 48), (200, 30, 30))
    src = str(tmp_path / "img.pdf")
    img.save(src, "PDF", resolution=72.0)
    before = PdfReader(src).pages[0]
    before_content = before.get_contents().get_data()
    xobj = before["/Resources"]["/XObject"]
    before_images = {k: v.get_object()._data for k, v in xobj.items()}
    assert before_images

    dst = str(tmp_path / "out.pdf")
    pdftext.overlay(src, dst, {0: {"scale": 1.0, "lines": [[{"t": "abc", "q": _quad(5, 5, 30, 10)}]]}})
    after = PdfReader(dst).pages[0]
    parts = after["/Contents"]
    assert isinstance(parts, ArrayObject) or isinstance(parts, list)
    streams = [p.get_object().get_data() for p in parts]
    assert streams[1] == before_content  # the original stream, untouched, between our q and the text
    assert b"3 Tr" in streams[2]
    after_images = {k: v.get_object()._data for k, v in after["/Resources"]["/XObject"].items()}
    assert after_images == before_images
    assert "abc" in after.extract_text()


def test_metadata_and_outline_kept(tmp_path):
    src = _make_pdf(tmp_path / "in.pdf")
    dst = str(tmp_path / "out.pdf")
    pdftext.overlay(src, dst, {0: {"scale": SCALE, "lines": LINES}})
    r = PdfReader(dst)
    assert r.metadata.title == "Original title"
    assert [o.title for o in r.outline] == ["Chapter"]


def test_input_not_modified_and_pages_without_entry_untouched(tmp_path):
    w = PdfWriter()
    for _ in range(2):
        w.add_blank_page(200, 200)
    src = tmp_path / "two.pdf"
    with open(src, "wb") as f:
        w.write(f)
    raw = src.read_bytes()
    dst = str(tmp_path / "out.pdf")
    n = pdftext.overlay(str(src), dst, {1: {"scale": 1.0, "lines": [[{"t": "second", "q": _quad(10, 10, 60, 12)}]]}})
    assert n == 1 and src.read_bytes() == raw
    r = PdfReader(dst)
    assert len(r.pages) == 2
    assert r.pages[0].extract_text().strip() == ""
    assert "second" in r.pages[1].extract_text()


def test_inherited_resources_kept(tmp_path):
    w = PdfWriter()
    page = w.add_blank_page(200, 200)
    parent = page["/Parent"].get_object()
    parent[NameObject("/Resources")] = DictionaryObject({NameObject("/ProcSet"): ArrayObject([NameObject("/PDF")])})
    del page["/Resources"]
    src = tmp_path / "inh.pdf"
    with open(src, "wb") as f:
        w.write(f)
    dst = str(tmp_path / "out.pdf")
    pdftext.overlay(str(src), dst, {0: {"scale": 1.0, "lines": [[{"t": "word", "q": _quad(10, 10, 60, 12)}]]}})
    res = PdfReader(dst).pages[0]["/Resources"]
    assert "/GLT" in res["/Font"] and "/ProcSet" in res


def test_encrypted_rejected(tmp_path):
    src = _make_pdf(tmp_path / "in.pdf")
    w = PdfWriter(clone_from=PdfReader(src))
    w.encrypt("secret")
    enc = tmp_path / "enc.pdf"
    with open(enc, "wb") as f:
        w.write(f)
    assert pdftext.is_encrypted(str(enc))
    with pytest.raises(pdftext.EncryptedPDF):
        pdftext.overlay(str(enc), str(tmp_path / "o.pdf"), {})


def test_font_blob_and_hex():
    data = pdftext.glyphless_ttf()
    assert len(data) == 624 and data[:4] == b"\x00\x01\x00\x00"
    assert pdftext.hexs("Aé") == "004100E9" and pdftext.hexs("\U0001F600") == "003F"


def test_degenerate_words_skipped(tmp_path):
    src = _make_pdf(tmp_path / "in.pdf")
    dst = str(tmp_path / "o.pdf")
    bad = [[{"t": " ", "q": _quad(10, 10, 50, 10)}, {"t": "x", "q": _quad(10, 10, 0.2, 10)}]]
    assert pdftext.overlay(src, dst, {0: {"scale": 1.0, "lines": bad}}) == 0
    io.BytesIO(open(dst, "rb").read())  # still a readable PDF
    assert len(PdfReader(dst).pages) == 1
