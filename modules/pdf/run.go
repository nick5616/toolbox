package pdf

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
)

// state holds the renderer and the password store.
type state struct {
	r   *renderer
	sec *secrets
}

func newState(cacheDir string) *state {
	return &state{r: newRenderer(cacheDir), sec: newSecrets()}
}

func (s *state) close() { s.r.close() }

const msgSecretGone = "The password isn't kept after a restart — run this again"

func isPDF(path string) bool { return strings.EqualFold(filepath.Ext(path), ".pdf") }

func isImage(path string) bool {
	return slices.Contains(ImageExtensions, strings.ToLower(filepath.Ext(path)))
}

func validAction(a Action) bool { return slices.Contains(AllActions(), a) }

// withDefaults fills empty option fields so API callers can pass partial options.
func withDefaults(o Options) Options {
	d := DefaultOptions()
	if o.SplitMode == "" {
		o.SplitMode = d.SplitMode
	}
	if o.Every == 0 {
		o.Every = d.Every
	}
	if o.Level == "" {
		o.Level = d.Level
	}
	if o.PageSize == "" {
		o.PageSize = d.PageSize
	}
	if o.Margin == "" {
		o.Margin = d.Margin
	}
	if o.ImageFormat == "" {
		o.ImageFormat = d.ImageFormat
	}
	if o.DPI == 0 {
		o.DPI = d.DPI
	}
	if o.Pages == nil {
		o.Pages = []PageEdit{}
	}
	return o
}

func fieldErr(field, msg string) error {
	return core.ValidationError(msg, map[string]string{field: msg})
}

// checkInputs validates input kinds, counts and sizes for the action.
func checkInputs(action Action, inputs []string) error {
	if len(inputs) == 0 {
		return fieldErr("inputs", "Add at least one file")
	}
	if action == ActionImagesToPDF {
		for _, in := range inputs {
			if !isImage(in) {
				return fieldErr("inputs", fmt.Sprintf("%s isn't an image (jpg, png, tif or webp)", filepath.Base(in)))
			}
		}
		return nil
	}
	for _, in := range inputs {
		if !isPDF(in) {
			return fieldErr("inputs", fmt.Sprintf("%s isn't a PDF", filepath.Base(in)))
		}
		if _, err := statPDF(in); err != nil {
			return err
		}
	}
	switch action {
	case ActionMerge:
		if len(inputs) < 2 {
			return fieldErr("inputs", "Add at least two PDFs to merge")
		}
	case ActionOrganize:
		if len(inputs) != 1 {
			return fieldErr("inputs", "Organize works on one PDF at a time")
		}
	}
	return nil
}

// checkOptions validates the options that don't need the documents.
func (m *Module) checkOptions(o Options) error {
	if !validAction(o.Action) {
		return fieldErr("action", fmt.Sprintf("Unknown action %q", o.Action))
	}
	switch o.Action {
	case ActionSplit:
		switch o.SplitMode {
		case SplitEvery:
			if o.Every < 1 {
				return fieldErr("every", "Pages per file must be at least 1")
			}
		case SplitRanges:
			if _, err := parseRanges(o.Ranges, 0); err != nil {
				return fieldErr("ranges", capitalize(err.Error()))
			}
		default:
			return fieldErr("splitMode", "Choose how to split")
		}
	case ActionOrganize:
		if len(o.Pages) == 0 {
			return fieldErr("pages", "Keep at least one page")
		}
		for _, p := range o.Pages {
			if p.Page < 1 {
				return fieldErr("pages", "Page numbers start at 1")
			}
			if !slices.Contains([]int{0, 90, 180, 270}, p.Rotate) {
				return fieldErr("pages", "Rotation must be 0, 90, 180 or 270")
			}
		}
	case ActionCompress:
		if !slices.Contains([]string{LevelSmall, LevelBalanced, LevelHigh}, o.Level) {
			return fieldErr("level", "Choose a compression level")
		}
	case ActionImagesToPDF:
		if !slices.Contains([]string{PageA4, PageLetter, PageFit}, o.PageSize) {
			return fieldErr("pageSize", "Choose a page size")
		}
		if !slices.Contains([]string{MarginNone, MarginSmall}, o.Margin) {
			return fieldErr("margin", "Choose a margin")
		}
	case ActionPDFToImages:
		if !slices.Contains([]string{ImagePNG, ImageJPG}, o.ImageFormat) {
			return fieldErr("imageFormat", "Choose PNG or JPG")
		}
		if !slices.Contains([]int{72, 150, 300}, o.DPI) {
			return fieldErr("dpi", "Resolution must be 72, 150 or 300 dpi")
		}
		if strings.TrimSpace(o.PageRange) != "" {
			if _, err := parseRanges(o.PageRange, 0); err != nil {
				return fieldErr("pageRange", capitalize(err.Error()))
			}
		}
	}
	if o.PasswordRef != "" {
		if _, _, ok := m.state.sec.get(o.PasswordRef); !ok {
			return core.ValidationError(msgSecretGone, nil)
		}
	}
	switch o.Action {
	case ActionProtect:
		if _, np, ok := m.state.sec.get(o.PasswordRef); !ok || np == "" {
			return fieldErr("newPassword", "Enter a password to protect the PDF with")
		}
	case ActionUnlock:
		if pw, _, ok := m.state.sec.get(o.PasswordRef); !ok || pw == "" {
			return fieldErr("password", "Enter the PDF's password")
		}
	}
	return nil
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// validate implements Module.Validate (synchronous, at submit).
func (m *Module) validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	if err := m.checkOptions(o); err != nil {
		return err
	}
	return checkInputs(o.Action, inputs)
}

// run implements Module.Run.
func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := m.checkOptions(o); err != nil {
		return err
	}
	if err := checkInputs(o.Action, job.Inputs); err != nil {
		return err
	}
	password, newPassword := "", ""
	if o.PasswordRef != "" {
		password, newPassword, _ = m.state.sec.get(o.PasswordRef)
	}
	r := &runner{m: m, job: job, opts: o, password: password, newPassword: newPassword,
		res: Result{Action: o.Action, Outputs: []string{}}}
	defer r.cleanup()

	switch o.Action {
	case ActionMerge:
		err = r.merge(ctx)
	case ActionSplit:
		err = r.split(ctx)
	case ActionOrganize:
		err = r.organize(ctx)
	case ActionCompress:
		err = r.compress(ctx)
	case ActionImagesToPDF:
		err = r.imagesToPDF(ctx)
	case ActionPDFToImages:
		err = r.pdfToImages(ctx)
	case ActionProtect:
		err = r.protect(ctx)
	case ActionUnlock:
		err = r.unlock(ctx)
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	}
	if err := job.SetResult(r.res); err != nil {
		return err
	}
	if o.PasswordRef != "" {
		m.state.sec.jobDone(o.PasswordRef)
	}
	return nil
}

// runner carries one job's state.
type runner struct {
	m           *Module
	job         *core.JobContext
	opts        Options
	password    string
	newPassword string
	res         Result
	tmp         string // own scratch dir when job.TempDir is empty
	partial     []string
}

func (r *runner) cleanup() {
	if r.tmp != "" {
		_ = os.RemoveAll(r.tmp)
	}
}

// scratch returns a fresh directory for intermediate files.
func (r *runner) scratch() (string, error) {
	base := r.job.TempDir
	if base == "" {
		if r.tmp == "" {
			d, err := os.MkdirTemp("", "toolbox-pdf-")
			if err != nil {
				return "", fmt.Errorf("create scratch dir: %w", err)
			}
			r.tmp = d
		}
		base = r.tmp
	}
	return os.MkdirTemp(base, "w-")
}

// outPath reserves a unique output path in the library folder.
func (r *runner) outPath(stem, suffix string) string {
	return core.UniquePath(r.job.OutputDir, stem+suffix, ".pdf")
}

// register adds a finished file to the job's outputs and the result.
func (r *runner) register(path string) error {
	if _, err := r.job.Output(path); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	r.res.Outputs = append(r.res.Outputs, path)
	if fi, err := os.Stat(path); err == nil {
		r.res.BytesAfter += fi.Size()
	}
	return nil
}

// open reads a PDF's info and refuses password-protected / restricted
// documents the job can't edit. forRender allows restricted documents.
func (r *runner) open(ctx context.Context, path string, forRender bool) (Info, error) {
	in, err := r.m.info(ctx, path, r.password)
	if err != nil {
		return Info{}, err
	}
	name := filepath.Base(path)
	if in.NeedsPassword {
		return Info{}, core.ValidationError(msgNeedPassword, nil).WithHint(name)
	}
	if in.Restricted && !forRender {
		return Info{}, core.ValidationError(msgRestricted, nil).WithHint(hintRestricted)
	}
	r.res.BytesBefore += in.Bytes
	return in, nil
}

// failed removes partial outputs after an error.
func (r *runner) failed(ctx context.Context, err error, paths ...string) error {
	removePartial(paths...)
	return mapErr(ctx, err, r.password)
}

func bookmarksNote(dropped bool) string {
	if dropped {
		return " · Bookmarks aren't kept"
	}
	return ""
}

var errNoOutput = errors.New("no output produced")
