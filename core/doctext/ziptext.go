package doctext

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"toolbox/core"
)

// Zip safety limits: Extract only ever reads named entries into memory.
const (
	maxEntries    = 10_000
	maxEntryBytes = 50 << 20
	maxTotalBytes = 200 << 20
	// maxRatio is the largest uncompressed:compressed ratio accepted for an
	// entry over 1 MiB.
	maxRatio = 300
)

var errBomb = core.ValidationError("This file looks like a zip bomb, so it was skipped", nil)

// zipDoc reads named entries of an open zip with the safety limits.
type zipDoc struct {
	rc    *zip.ReadCloser
	files map[string]*zip.File
	read  int64
}

func openZip(p string) (*zipDoc, error) {
	rc, err := zip.OpenReader(p)
	if err != nil {
		return nil, core.ValidationError("Not a valid document (couldn't open it as a zip)", nil)
	}
	if len(rc.File) > maxEntries {
		rc.Close()
		return nil, core.ValidationError("This file has too many parts to read", nil)
	}
	z := &zipDoc{rc: rc, files: make(map[string]*zip.File, len(rc.File))}
	for _, f := range rc.File {
		z.files[f.Name] = f
	}
	return z, nil
}

func (z *zipDoc) close() { z.rc.Close() }

func (z *zipDoc) has(name string) bool { _, ok := z.files[name]; return ok }

// names returns entry names matching re with the captured number, sorted by it.
func (z *zipDoc) numbered(re *regexp.Regexp) []string {
	type nn struct {
		name string
		n    int
	}
	var list []nn
	for name := range z.files {
		if m := re.FindStringSubmatch(name); m != nil {
			n, _ := strconv.Atoi(m[1])
			list = append(list, nn{name, n})
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].n < list[j].n })
	out := make([]string, len(list))
	for i, l := range list {
		out[i] = l.name
	}
	return out
}

// open returns a reader for the entry that stops after the per-entry cap and
// the remaining total budget. A missing entry is an error.
func (z *zipDoc) open(name string) (io.Reader, io.Closer, error) {
	f, ok := z.files[name]
	if !ok {
		return nil, nil, fmt.Errorf("missing %s", name)
	}
	if f.UncompressedSize64 > maxEntryBytes*4 {
		return nil, nil, errBomb
	}
	if f.UncompressedSize64 > 1<<20 && f.CompressedSize64 > 0 && f.UncompressedSize64/f.CompressedSize64 > maxRatio {
		return nil, nil, errBomb
	}
	if z.read >= maxTotalBytes {
		return nil, nil, errBomb
	}
	rc, err := f.Open()
	if err != nil {
		return nil, nil, err
	}
	budget := min(int64(maxEntryBytes), maxTotalBytes-z.read)
	return &countReader{r: io.LimitReader(rc, budget), z: z}, rc, nil
}

type countReader struct {
	r io.Reader
	z *zipDoc
}

func (c *countReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.z.read += int64(n)
	return n, err
}

// secBuilder collects text by section until the byte limit is reached.
type secBuilder struct {
	secs  []section
	cur   strings.Builder
	pos   int64
	used  int
	limit int
}

func newSecBuilder(limit int) *secBuilder { return &secBuilder{pos: -1, limit: limit} }

func (s *secBuilder) full() bool { return s.used >= s.limit }

func (s *secBuilder) write(t string) {
	if s.full() {
		return
	}
	s.cur.WriteString(t)
	s.used += len(t)
}

// begin ends the current section and starts one at pos.
func (s *secBuilder) begin(pos int64) {
	s.flush()
	s.pos = pos
}

func (s *secBuilder) flush() {
	if strings.TrimSpace(s.cur.String()) != "" {
		s.secs = append(s.secs, section{pos: s.pos, text: s.cur.String()})
	}
	s.cur.Reset()
}

func (s *secBuilder) done() []section {
	s.flush()
	return s.secs
}

// walkXML feeds tokens to fn until it returns false or the XML ends/breaks.
// Malformed or truncated XML simply ends the walk with what was read.
func walkXML(r io.Reader, fn func(xml.Token) bool) {
	d := xml.NewDecoder(r)
	d.Strict = false
	for {
		tok, err := d.Token()
		if err != nil {
			return
		}
		if !fn(tok) {
			return
		}
	}
}

func attr(se xml.StartElement, local string) string {
	for _, a := range se.Attr {
		if a.Name.Local == local {
			return a.Value
		}
	}
	return ""
}

var (
	reSlide = regexp.MustCompile(`^ppt/slides/slide(\d+)\.xml$`)
	reSheet = regexp.MustCompile(`^xl/worksheets/sheet(\d+)\.xml$`)
)

func extractZip(p, ext string, limit int) ([]section, error) {
	z, err := openZip(p)
	if err != nil {
		return nil, err
	}
	defer z.close()
	sb := newSecBuilder(limit)
	bad := func(what string) error {
		return core.ValidationError("Not a valid "+what+" file (its text part is missing)", nil)
	}
	switch ext {
	case ".docx":
		if !z.has("word/document.xml") {
			return nil, bad(".docx")
		}
		if err := z.walk("word/document.xml", func(r io.Reader) { walkRuns(r, sb) }); err != nil {
			return nil, err
		}
	case ".pptx":
		slides := z.numbered(reSlide)
		if len(slides) == 0 {
			return nil, bad(".pptx")
		}
		for i, name := range slides {
			if sb.full() {
				break
			}
			sb.begin(int64(i))
			if err := z.walk(name, func(r io.Reader) { walkRuns(r, sb) }); err != nil {
				return nil, err
			}
		}
	case ".xlsx":
		if err := extractXLSX(z, sb); err != nil {
			return nil, err
		}
	case ".odt", ".odp", ".ods":
		if !z.has("content.xml") {
			return nil, bad(ext)
		}
		if err := z.walk("content.xml", func(r io.Reader) { walkODF(r, ext, sb) }); err != nil {
			return nil, err
		}
	case ".epub":
		if err := extractEPUB(z, sb); err != nil {
			return nil, err
		}
	}
	return sb.done(), nil
}

// walk opens name and runs fn on it, closing it after. Limit errors (bombs)
// are returned; a missing entry is not.
func (z *zipDoc) walk(name string, fn func(io.Reader)) error {
	r, c, err := z.open(name)
	if err != nil {
		if errors.Is(err, errBomb) || core.IsCode(err, core.CodeValidation) {
			return err
		}
		return nil
	}
	defer c.Close()
	fn(r)
	return nil
}

// walkRuns reads WordprocessingML and DrawingML text: w:t / a:t inside
// paragraphs, tabs and breaks inside runs.
func walkRuns(r io.Reader, sb *secBuilder) {
	inT, inRun := false, false
	walkXML(r, func(tok xml.Token) bool {
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "r":
				inRun = true
			case "t":
				inT = true
			case "tab":
				if inRun {
					sb.write("\t")
				}
			case "br", "cr":
				sb.write("\n")
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "r":
				inRun = false
			case "t":
				inT = false
			case "p":
				sb.write("\n")
			}
		case xml.CharData:
			if inT {
				sb.write(string(t))
			}
		}
		return !sb.full()
	})
}

func extractXLSX(z *zipDoc, sb *secBuilder) error {
	sheets := z.numbered(reSheet)
	if len(sheets) == 0 {
		return core.ValidationError("Not a valid .xlsx file (it has no sheets)", nil)
	}
	var shared []string
	if err := z.walk("xl/sharedStrings.xml", func(r io.Reader) {
		total := 0
		var cur strings.Builder
		inSI, inT, inPh := false, false, false
		walkXML(r, func(tok xml.Token) bool {
			switch t := tok.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "si":
					inSI = true
					cur.Reset()
				case "rPh":
					inPh = true
				case "t":
					inT = true
				}
			case xml.EndElement:
				switch t.Name.Local {
				case "si":
					inSI = false
					shared = append(shared, cur.String())
					total += cur.Len()
				case "rPh":
					inPh = false
				case "t":
					inT = false
				}
			case xml.CharData:
				if inSI && inT && !inPh {
					cur.WriteString(string(t))
				}
			}
			return total < sb.limit*4
		})
	}); err != nil {
		return err
	}
	for i, name := range sheets {
		if sb.full() {
			break
		}
		sb.begin(int64(i))
		if err := z.walk(name, func(r io.Reader) { walkSheet(r, shared, sb) }); err != nil {
			return err
		}
	}
	return nil
}

func walkSheet(r io.Reader, shared []string, sb *secBuilder) {
	var (
		cellType string
		val      strings.Builder
		inV, inT bool
	)
	walkXML(r, func(tok xml.Token) bool {
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "c":
				cellType = attr(t, "t")
				val.Reset()
			case "v":
				inV = true
			case "t":
				inT = true
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v":
				inV = false
			case "t":
				inT = false
			case "c":
				s := ""
				switch cellType {
				case "s":
					if n, err := strconv.Atoi(strings.TrimSpace(val.String())); err == nil && n >= 0 && n < len(shared) {
						s = shared[n]
					}
				case "str", "inlineStr":
					s = val.String()
				}
				if s != "" {
					sb.write(s)
					sb.write("\t")
				}
			case "row":
				sb.write("\n")
			}
		case xml.CharData:
			if inV || inT {
				val.WriteString(string(t))
			}
		}
		return !sb.full()
	})
}

// walkODF reads OpenDocument content.xml: text:p / text:h paragraphs, with a
// new section per draw:page (odp) or table:table (ods).
func walkODF(r io.Reader, ext string, sb *secBuilder) {
	sectionTag := map[string]string{".odp": "page", ".ods": "table"}[ext]
	depth := 0 // inside p/h
	sections := int64(0)
	walkXML(r, func(tok xml.Token) bool {
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p", "h":
				depth++
			case "s":
				if depth > 0 {
					n := 1
					if c, err := strconv.Atoi(attr(t, "c")); err == nil && c > 0 && c < 100 {
						n = c
					}
					sb.write(strings.Repeat(" ", n))
				}
			case "tab":
				if depth > 0 {
					sb.write("\t")
				}
			case "line-break":
				if depth > 0 {
					sb.write("\n")
				}
			case sectionTag:
				if sectionTag != "" {
					sb.begin(sections)
					sections++
				}
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "p", "h":
				if depth > 0 {
					depth--
				}
				sb.write("\n")
			}
		case xml.CharData:
			if depth > 0 {
				sb.write(string(t))
			}
		}
		return !sb.full()
	})
}

func extractEPUB(z *zipDoc, sb *secBuilder) error {
	var rootfile string
	_ = z.walk("META-INF/container.xml", func(r io.Reader) {
		walkXML(r, func(tok xml.Token) bool {
			if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "rootfile" {
				rootfile = attr(se, "full-path")
				return false
			}
			return true
		})
	})
	var order []string
	if rootfile != "" {
		dir := path.Dir(rootfile)
		manifest := map[string]string{}
		var spine []string
		_ = z.walk(rootfile, func(r io.Reader) {
			walkXML(r, func(tok xml.Token) bool {
				if se, ok := tok.(xml.StartElement); ok {
					switch se.Name.Local {
					case "item":
						manifest[attr(se, "id")] = attr(se, "href")
					case "itemref":
						spine = append(spine, attr(se, "idref"))
					}
				}
				return true
			})
		})
		for _, id := range spine {
			href, ok := manifest[id]
			if !ok {
				continue
			}
			if u, err := url.PathUnescape(href); err == nil {
				href = u
			}
			if i := strings.IndexByte(href, '#'); i >= 0 {
				href = href[:i]
			}
			name := path.Clean(path.Join(dir, href))
			if strings.HasPrefix(name, "../") || name == ".." {
				continue
			}
			order = append(order, name)
		}
	}
	if len(order) == 0 {
		for name := range z.files {
			l := strings.ToLower(name)
			if strings.HasSuffix(l, ".xhtml") || strings.HasSuffix(l, ".html") || strings.HasSuffix(l, ".htm") {
				order = append(order, name)
			}
		}
		sort.Strings(order)
	}
	if len(order) == 0 {
		return core.ValidationError("Not a valid .epub file (it has no chapters)", nil)
	}
	for _, name := range order {
		if sb.full() {
			break
		}
		if err := z.walk(name, func(r io.Reader) {
			b, _ := io.ReadAll(r)
			sb.write(strings.TrimSpace(htmlText(cleanUTF8(b), sb.limit-sb.used)))
			sb.write("\n\n")
		}); err != nil {
			return err
		}
	}
	return nil
}
