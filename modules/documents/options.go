package documents

// Format is a document format the converter reads and/or writes.
type Format string

const (
	FormatDOCX  Format = "docx"
	FormatODT   Format = "odt"
	FormatRTF   Format = "rtf"
	FormatEPUB  Format = "epub"
	FormatHTML  Format = "html"
	FormatMD    Format = "md"
	FormatGFM   Format = "gfm"
	FormatLaTeX Format = "latex"
	FormatTypst Format = "typst"
	FormatIPYNB Format = "ipynb"
	FormatPPTX  Format = "pptx"
	FormatTXT   Format = "txt"
	FormatPDF   Format = "pdf"
)

// Options are the Document Converter's per-submission options.
type Options struct {
	To             Format `json:"to"`
	PageSize       string `json:"pageSize"` // "a4" | "letter" (pdf/typst)
	MarginMm       int    `json:"marginMm"` // 10..50
	MainFont       string `json:"mainFont"` // "" = default; from media.Fonts()
	FontSizePt     int    `json:"fontSizePt"`
	TOC            bool   `json:"toc"`
	NumberSections bool   `json:"numberSections"`
	ReferenceDoc   string `json:"referenceDoc"`   // docx/odt styles source; must exist
	EmbedResources bool   `json:"embedResources"` // html: --standalone --embed-resources
	ExtractMedia   bool   `json:"extractMedia"`   // md/html out: media into "<name>_media/"
}

// DefaultOptions: docx, A4, 25 mm margins, 11 pt, embedded HTML resources.
func DefaultOptions() Options {
	return Options{To: FormatDOCX, PageSize: "a4", MarginMm: 25, FontSizePt: 11, EmbedResources: true}
}

type formatSpec struct {
	Format Format
	Label  string
	Ext    string // output extension
	Writer string // pandoc -t value (pdf: typst, with --pdf-engine)
	Reader string // pandoc -f value ("" = cannot be read)
	// Standalone makes the writer need -s.
	Standalone bool
	// Exts are the input extensions that mean this format.
	Exts []string
}

// formats is the table of every format, in UI order.
var formats = []formatSpec{
	{FormatDOCX, "Word (docx)", ".docx", "docx", "docx", false, []string{".docx"}},
	{FormatPDF, "PDF", ".pdf", "pdf", "", false, nil},
	{FormatODT, "OpenDocument (odt)", ".odt", "odt", "odt", false, []string{".odt"}},
	{FormatRTF, "Rich Text (rtf)", ".rtf", "rtf", "rtf", true, []string{".rtf"}},
	{FormatEPUB, "EPUB", ".epub", "epub3", "epub", false, []string{".epub"}},
	{FormatHTML, "HTML", ".html", "html5", "html", true, []string{".html", ".htm"}},
	{FormatMD, "Markdown", ".md", "markdown", "markdown", false, []string{".md", ".markdown"}},
	{FormatGFM, "Markdown (GitHub)", ".md", "gfm", "gfm", false, nil},
	{FormatLaTeX, "LaTeX", ".tex", "latex", "latex", true, []string{".tex"}},
	{FormatTypst, "Typst", ".typ", "typst", "typst", true, []string{".typ"}},
	{FormatIPYNB, "Jupyter notebook", ".ipynb", "ipynb", "ipynb", false, []string{".ipynb"}},
	{FormatPPTX, "PowerPoint (pptx)", ".pptx", "pptx", "", false, nil},
	{FormatTXT, "Plain text", ".txt", "plain", "markdown", false, []string{".txt"}},
}

func lookupFormat(f Format) (formatSpec, bool) {
	for _, s := range formats {
		if s.Format == f {
			return s, true
		}
	}
	return formatSpec{}, false
}

// Accepts lists the input extensions.
func Accepts() []string {
	var out []string
	for _, s := range formats {
		out = append(out, s.Exts...)
	}
	return out
}

// inputFormat maps an extension (lowercase, with dot) to the format read.
func inputFormat(ext string) (formatSpec, bool) {
	for _, s := range formats {
		for _, e := range s.Exts {
			if e == ext {
				return s, true
			}
		}
	}
	return formatSpec{}, false
}
