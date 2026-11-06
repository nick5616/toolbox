package archiver

// Options are the Web Archiver's job options (SPEC Phase 12 §5.2). The inputs
// of a job are the URLs; URLs in the options is accepted for completeness but
// the job's inputs are authoritative.
type Options struct {
	URLs       []string `json:"urls"`
	RenderJS   bool     `json:"renderJs"`   // run a headless browser first and archive the rendered DOM
	NoJS       bool     `json:"noJs"`       // monolith -j: strip scripts from the saved page
	NoImages   bool     `json:"noImages"`   // monolith -i: leave images out
	AlsoPDF    bool     `json:"alsoPdf"`    // also print the page to PDF with the browser
	TimeoutSec int      `json:"timeoutSec"` // 10..300 (network timeout per request)
	AllowLocal bool     `json:"allowLocal"` // allow loopback / private / link-local addresses
}

// Timeout bounds for TimeoutSec.
const (
	MinTimeoutSec     = 10
	MaxTimeoutSec     = 300
	DefaultTimeoutSec = 60
)

// DefaultOptions returns the defaults.
func DefaultOptions() Options {
	return Options{URLs: []string{}, TimeoutSec: DefaultTimeoutSec}
}

// BrowserInfo tells the UI whether Render JavaScript / Also PDF can work.
type BrowserInfo struct {
	Found bool   `json:"found"`
	Name  string `json:"name"` // "Microsoft Edge" or "Google Chrome"; "" when not found
}
