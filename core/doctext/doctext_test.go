package doctext

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

// mkzip writes a zip with the given entries (in map order, stored sorted by the caller if it matters).
func mkzip(t *testing.T, name string, entries [][2]string) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.Create(e[0])
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return writeFile(t, name, buf.Bytes())
}

func writeFile(t *testing.T, name string, b []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func joined(cs []Chunk) string {
	var parts []string
	for _, c := range cs {
		parts = append(parts, c.Text)
	}
	return strings.Join(parts, "\n")
}

func mustExtract(t *testing.T, p string, limit int) []Chunk {
	t.Helper()
	cs, err := Extract(p, limit)
	if err != nil {
		t.Fatalf("Extract(%s): %v", filepath.Base(p), err)
	}
	return cs
}

func TestPlainTextFormats(t *testing.T) {
	for _, name := range []string{"a.txt", "a.md", "a.markdown", "a.csv", "a.json"} {
		p := writeFile(t, name, []byte("\xef\xbb\xbfhello world\nsecond line"))
		cs := mustExtract(t, p, 0)
		if len(cs) != 1 || cs[0].Text != "hello world\nsecond line" || cs[0].Pos != -1 || cs[0].EndPos != -1 {
			t.Errorf("%s: %+v", name, cs)
		}
	}
}

func TestInvalidUTF8Replaced(t *testing.T) {
	p := writeFile(t, "bad.txt", []byte("ok \xff\xfe bytes"))
	cs := mustExtract(t, p, 0)
	if len(cs) != 1 || !strings.Contains(cs[0].Text, "�") || !strings.HasPrefix(cs[0].Text, "ok ") {
		t.Errorf("got %+v", cs)
	}
}

func TestUnsupportedAndMissing(t *testing.T) {
	p := writeFile(t, "a.exe", []byte("x"))
	if _, err := Extract(p, 0); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("unsupported: %v", err)
	}
	if _, err := Extract(filepath.Join(t.TempDir(), "none.txt"), 0); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("missing: %v", err)
	}
	notZip := writeFile(t, "x.docx", []byte("not a zip"))
	if _, err := Extract(notZip, 0); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("bad zip: %v", err)
	}
	noDoc := mkzip(t, "y.docx", [][2]string{{"other.xml", "<a/>"}})
	if _, err := Extract(noDoc, 0); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("missing part: %v", err)
	}
}

func TestChunking(t *testing.T) {
	var lines []string
	for i := 0; i < 100; i++ {
		lines = append(lines, strings.Repeat("w", 49)+" ")
	}
	p := writeFile(t, "long.txt", []byte(strings.Join(lines, "\n")))
	cs := mustExtract(t, p, 0)
	if len(cs) < 4 {
		t.Fatalf("expected several chunks, got %d", len(cs))
	}
	for _, c := range cs {
		if n := len([]rune(c.Text)); n > ChunkChars {
			t.Errorf("chunk of %d chars", n)
		}
	}
	// One huge line is cut at spaces, never mid-word when a space is near.
	huge := strings.Repeat("word ", 1000)
	for _, s := range SplitText(huge) {
		if len([]rune(s)) > ChunkChars || !strings.HasPrefix(s, "word") || !strings.HasSuffix(s, "word") {
			t.Fatalf("bad piece %q…", s[:min(20, len(s))])
		}
	}
}

func TestLimit(t *testing.T) {
	p := writeFile(t, "big.txt", []byte(strings.Repeat("abcdefghi\n", 5000)))
	cs := mustExtract(t, p, 3000)
	total := 0
	for _, c := range cs {
		total += len(c.Text)
	}
	if total > 3000 || total < 2000 {
		t.Errorf("total %d, want ≤ 3000 and close to it", total)
	}
	// Multi-byte text is cut on a rune boundary.
	p2 := writeFile(t, "cjk.txt", []byte(strings.Repeat("日本語", 2000)))
	for _, c := range mustExtract(t, p2, 1000) {
		if !strings.HasSuffix(c.Text, "語") && !strings.HasSuffix(c.Text, "日") && !strings.HasSuffix(c.Text, "本") {
			t.Errorf("cut inside a rune: %q", c.Text[len(c.Text)-3:])
		}
	}
}

func TestSRT(t *testing.T) {
	src := "1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Hello</i> there\r\n\r\n2\r\n01:02:03,250 --> 01:02:05,000\r\nSecond &amp; last\r\nline two\r\n\r\n"
	cs := mustExtract(t, writeFile(t, "a.srt", []byte(src)), 0)
	if len(cs) != 2 {
		t.Fatalf("got %+v", cs)
	}
	if cs[0].Pos != 1000 || cs[0].EndPos != 3500 || cs[0].Text != "Hello there" {
		t.Errorf("cue 0 = %+v", cs[0])
	}
	if cs[1].Pos != 3723250 || cs[1].EndPos != 3725000 || cs[1].Text != "Second & last\nline two" {
		t.Errorf("cue 1 = %+v", cs[1])
	}
}

func TestVTT(t *testing.T) {
	src := "WEBVTT\n\nNOTE a comment\n\nintro\n00:01.500 --> 00:04.000 align:start\n<v Bob>Hi <b>there</b>\n\n01:00:00.000 --> 01:00:01.000\nLate\n"
	cs := mustExtract(t, writeFile(t, "a.vtt", []byte(src)), 0)
	if len(cs) != 2 || cs[0].Pos != 1500 || cs[0].EndPos != 4000 || cs[0].Text != "Hi there" || cs[1].Pos != 3600000 {
		t.Errorf("got %+v", cs)
	}
}

func TestLRC(t *testing.T) {
	src := "[ti:Song]\n[00:12.50]First line\n[00:15.00][00:40.5]Chorus\n[00:20]<00:20.1>Second\n"
	cs := mustExtract(t, writeFile(t, "a.lrc", []byte(src)), 0)
	if len(cs) != 4 {
		t.Fatalf("got %+v", cs)
	}
	if cs[0].Pos != 12500 || cs[0].EndPos != 15000 || cs[0].Text != "First line" {
		t.Errorf("0 = %+v", cs[0])
	}
	if cs[1].Text != "Chorus" || cs[1].Pos != 15000 || cs[1].EndPos != 20000 {
		t.Errorf("1 = %+v", cs[1])
	}
	if cs[3].Pos != 40500 || cs[3].EndPos != 45500 {
		t.Errorf("last = %+v", cs[3])
	}
}

func TestASS(t *testing.T) {
	src := "[Script Info]\nTitle: x\n\n[V4+ Styles]\nStyle: Default,Arial\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
		"Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\an8\\i1}Hello, world\\Nsecond\n" +
		"Dialogue: 0,0:01:00.00,0:01:02.00,Default,,0,0,0,,{\\b1}{\\b0}\n"
	cs := mustExtract(t, writeFile(t, "a.ass", []byte(src)), 0)
	if len(cs) != 1 || cs[0].Pos != 1500 || cs[0].EndPos != 3000 || cs[0].Text != "Hello, world\nsecond" {
		t.Errorf("got %+v", cs)
	}
}

func TestHTML(t *testing.T) {
	src := `<!doctype html><html><head><title>T</title><style>p{color:red}</style><script>var secret=1;</script></head>
<body><h1>Heading</h1><p>First <b>bold</b>   para</p><script>alert("no")</script><ul><li>one</li><li>two</li></ul><!-- hidden --></body></html>`
	cs := mustExtract(t, writeFile(t, "a.html", []byte(src)), 0)
	got := joined(cs)
	for _, bad := range []string{"secret", "alert", "color", "hidden"} {
		if strings.Contains(got, bad) {
			t.Errorf("text contains %q: %q", bad, got)
		}
	}
	if got != "Heading\nFirst bold para\none\ntwo" {
		t.Errorf("got %q", got)
	}
}

func TestDOCX(t *testing.T) {
	doc := `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
<w:p><w:pPr><w:tabs><w:tab w:val="left"/></w:tabs></w:pPr><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> world</w:t></w:r></w:p>
<w:p><w:r><w:t>Second</w:t><w:br/><w:t>paragraph</w:t></w:r></w:p></w:body></w:document>`
	p := mkzip(t, "a.docx", [][2]string{{"word/document.xml", doc}})
	cs := mustExtract(t, p, 0)
	if len(cs) != 1 || cs[0].Text != "Hello\t world\nSecond\nparagraph" || cs[0].Pos != -1 {
		t.Errorf("got %+v", cs)
	}
}

func TestPPTXPositions(t *testing.T) {
	slide := func(s string) string {
		return `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>` + s + `</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
	}
	p := mkzip(t, "a.pptx", [][2]string{
		{"ppt/slides/slide10.xml", slide("Tenth")},
		{"ppt/slides/slide2.xml", slide("Second")},
		{"ppt/slides/slide1.xml", slide("First")},
		{"ppt/notesSlides/notesSlide1.xml", slide("Notes")},
	})
	cs := mustExtract(t, p, 0)
	want := []struct {
		pos  int64
		text string
	}{{0, "First"}, {1, "Second"}, {2, "Tenth"}}
	if len(cs) != len(want) {
		t.Fatalf("got %+v", cs)
	}
	for i, w := range want {
		if cs[i].Pos != w.pos || cs[i].Text != w.text {
			t.Errorf("chunk %d = %+v, want %+v", i, cs[i], w)
		}
	}
}

func TestXLSX(t *testing.T) {
	shared := `<sst><si><t>Alpha</t></si><si><r><t>Be</t></r><r><t>ta</t></r><rPh><t>PHONETIC</t></rPh></si><si><t>Gamma</t></si></sst>`
	sheet1 := `<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1" t="s"><v>1</v></c></row><row><c t="inlineStr"><is><t>Inline</t></is></c></row></sheetData></worksheet>`
	sheet2 := `<worksheet><sheetData><row><c t="s"><v>2</v></c></row></sheetData></worksheet>`
	p := mkzip(t, "a.xlsx", [][2]string{
		{"xl/sharedStrings.xml", shared},
		{"xl/worksheets/sheet2.xml", sheet2},
		{"xl/worksheets/sheet1.xml", sheet1},
	})
	cs := mustExtract(t, p, 0)
	if len(cs) != 2 {
		t.Fatalf("got %+v", cs)
	}
	if cs[0].Pos != 0 || cs[0].Text != "Alpha\tBeta\nInline" {
		t.Errorf("sheet 0 = %+v", cs[0])
	}
	if cs[1].Pos != 1 || cs[1].Text != "Gamma" {
		t.Errorf("sheet 1 = %+v", cs[1])
	}
	if strings.Contains(joined(cs), "PHONETIC") || strings.Contains(joined(cs), "42") {
		t.Errorf("phonetic or number leaked: %q", joined(cs))
	}
}

func TestODF(t *testing.T) {
	odt := `<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text>
<text:h>Title</text:h><text:p>Hello<text:s text:c="2"/>there<text:tab/>x<text:line-break/>y</text:p></office:text></office:body></office:document-content>`
	cs := mustExtract(t, mkzip(t, "a.odt", [][2]string{{"content.xml", odt}}), 0)
	if len(cs) != 1 || cs[0].Text != "Title\nHello  there\tx\ny" {
		t.Errorf("odt: %+v", cs)
	}

	odp := `<office:document-content xmlns:office="o" xmlns:text="t" xmlns:draw="d"><office:body><office:presentation>
<draw:page><text:p>Slide A</text:p></draw:page><draw:page><draw:frame><text:p>Slide B</text:p></draw:frame></draw:page></office:presentation></office:body></office:document-content>`
	cs = mustExtract(t, mkzip(t, "a.odp", [][2]string{{"content.xml", odp}}), 0)
	if len(cs) != 2 || cs[0].Pos != 0 || cs[0].Text != "Slide A" || cs[1].Pos != 1 || cs[1].Text != "Slide B" {
		t.Errorf("odp: %+v", cs)
	}

	ods := `<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:spreadsheet>
<table:table><table:table-row><table:table-cell><text:p>Cell1</text:p></table:table-cell></table:table-row></table:table>
<table:table><table:table-row><table:table-cell><text:p>Cell2</text:p></table:table-cell></table:table-row></table:table>
</office:spreadsheet></office:body></office:document-content>`
	cs = mustExtract(t, mkzip(t, "a.ods", [][2]string{{"content.xml", ods}}), 0)
	if len(cs) != 2 || cs[0].Text != "Cell1" || cs[1].Pos != 1 || cs[1].Text != "Cell2" {
		t.Errorf("ods: %+v", cs)
	}
}

func TestEPUBSpineOrder(t *testing.T) {
	container := `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`
	opf := `<package><manifest><item id="c1" href="ch1.xhtml"/><item id="c2" href="text/ch%202.xhtml"/><item id="css" href="s.css"/></manifest><spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>`
	p := mkzip(t, "a.epub", [][2]string{
		{"META-INF/container.xml", container},
		{"OEBPS/content.opf", opf},
		{"OEBPS/ch1.xhtml", `<html><body><p>Chapter one</p></body></html>`},
		{"OEBPS/text/ch 2.xhtml", `<html><body><p>Chapter two</p></body></html>`},
		{"OEBPS/unlisted.xhtml", `<html><body><p>Never</p></body></html>`},
	})
	got := joined(mustExtract(t, p, 0))
	if got != "Chapter two\n\nChapter one" && got != "Chapter two\nChapter one" {
		t.Errorf("got %q", got)
	}
	if strings.Contains(got, "Never") {
		t.Errorf("unlisted chapter read: %q", got)
	}
}

func TestZipEntryCount(t *testing.T) {
	var entries [][2]string
	entries = append(entries, [2]string{"word/document.xml", "<w:document/>"})
	for i := 0; i <= maxEntries; i++ {
		entries = append(entries, [2]string{"x/" + strings.Repeat("a", 3) + string(rune('a'+i%26)) + "-" + itoa(i), ""})
	}
	p := mkzip(t, "many.docx", entries)
	if _, err := Extract(p, 0); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("too many entries: %v", err)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for ; i > 0; i /= 10 {
		b = append([]byte{byte('0' + i%10)}, b...)
	}
	return string(b)
}

func TestZipBombRatioGuard(t *testing.T) {
	// 20 MB of zeros deflate to ~20 KB: a ratio far above the guard.
	big := `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>` + strings.Repeat("a", 20<<20) + `</w:t></w:r></w:p></w:body></w:document>`
	p := mkzip(t, "bomb.docx", [][2]string{{"word/document.xml", big}})
	_, err := Extract(p, 0)
	if !core.IsCode(err, core.CodeValidation) || !strings.Contains(err.Error(), "bomb") {
		t.Errorf("want a zip bomb error, got %v", err)
	}
}

func TestZipTextStopsAtLimit(t *testing.T) {
	// A big but ordinary (low-ratio) document is read only up to the limit.
	var sb strings.Builder
	sb.WriteString(`<w:document xmlns:w="x"><w:body>`)
	for i := 0; i < 20000; i++ {
		sb.WriteString(`<w:p><w:r><w:t>line ` + itoa(i*7919%100003) + ` of the document</w:t></w:r></w:p>`)
	}
	sb.WriteString(`</w:body></w:document>`)
	p := mkzip(t, "long.docx", [][2]string{{"word/document.xml", sb.String()}})
	cs := mustExtract(t, p, 5000)
	total := 0
	for _, c := range cs {
		total += len(c.Text)
		if c.Pos != -1 {
			t.Errorf("pos %d", c.Pos)
		}
	}
	if total > 5000 || total < 4000 {
		t.Errorf("total %d", total)
	}
}

func TestSupportedAndExtensions(t *testing.T) {
	if !Supported("X.DOCX") || Supported("a.pdf") || !IsSubtitle("a.SRT") || IsSubtitle("a.txt") {
		t.Error("Supported/IsSubtitle wrong")
	}
	exts := Extensions()
	if len(exts) != 18 || exts[0] != ".ass" {
		t.Errorf("Extensions = %v", exts)
	}
}
