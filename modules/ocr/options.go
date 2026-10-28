package ocr

// Language selects the detection/recognition models (SPEC.md §5.1).
type Language string

const (
	LangLatin      Language = "latin" // default; also Chinese and Japanese (bundled models)
	LangCyrillic   Language = "cyrillic"
	LangArabic     Language = "arabic"
	LangKorean     Language = "korean"
	LangGreek      Language = "greek"
	LangThai       Language = "thai"
	LangDevanagari Language = "devanagari"
)

// PDFOutput is what PDF inputs produce.
type PDFOutput string

const (
	PDFSearchable PDFOutput = "searchable"
	PDFText       PDFOutput = "text"
	PDFBoth       PDFOutput = "both"
)

// ImageOutput is what image inputs produce.
type ImageOutput string

const (
	ImageText ImageOutput = "text"
	ImageJSON ImageOutput = "json" // lines + word boxes
)

// Options are OCR's per-submission options.
type Options struct {
	Language    Language    `json:"language"`
	PDFOutput   PDFOutput   `json:"pdfOutput"`
	ImageOutput ImageOutput `json:"imageOutput"`
	SkipText    bool        `json:"skipText"` // PDFs: skip pages that already contain text
}

// DefaultOptions: Latin, searchable PDFs, plain text for images, skip text pages.
func DefaultOptions() Options {
	return Options{Language: LangLatin, PDFOutput: PDFSearchable, ImageOutput: ImageText, SkipText: true}
}

// Result is a job's result (images: SPEC.md §5.2; PDFs: §5.3).
type Result struct {
	Kind           string   `json:"kind"` // "image" | "pdf"
	Lines          int      `json:"lines"`
	Characters     int      `json:"characters"`
	MeanConfidence float64  `json:"meanConfidence"`
	Preview        string   `json:"preview"` // images: first 2,000 characters
	Pages          int      `json:"pages"`
	PagesOcred     int      `json:"pagesOcred"`
	PagesSkipped   int      `json:"pagesSkipped"`
	Outputs        []string `json:"outputs"`
}

// LanguageInfo describes a language choice for the UI.
type LanguageInfo struct {
	ID            Language `json:"id"`
	Label         string   `json:"label"`
	DownloadBytes int64    `json:"downloadBytes"` // 0 = bundled
}
