package archiver

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/proc"
)

// URLResult is the per-URL outcome stored as the job's result.
type URLResult struct {
	URL    string `json:"url"`
	OK     bool   `json:"ok"`
	Error  string `json:"error"`
	Title  string `json:"title"`
	Page   string `json:"page"` // saved .html path
	PDF    string `json:"pdf"`  // saved .pdf path, "" when not requested or failed
	PDFErr string `json:"pdfError"`
}

// Summary is the job result: one entry per input URL.
type Summary struct {
	Results []URLResult `json:"results"`
}

// errStepTimeout marks a tool that ran past its time budget.
var errStepTimeout = errors.New("timed out")

// stepBudget is the longest one tool run may take for a per-request timeout
// of sec seconds (monolith's -t applies to each request, not the whole page).
func stepBudget(sec int) time.Duration {
	return time.Duration(sec*4+30) * time.Second
}

// runStep runs one tool under the step budget. A cancelled ctx is returned as
// is (wrapped); a spent budget returns errStepTimeout.
func runStep(ctx context.Context, budget time.Duration, spec proc.Spec) (proc.Result, error) {
	sctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	res, err := proc.Run(sctx, spec)
	if err != nil {
		if ctx.Err() != nil {
			return res, fmt.Errorf("cancelled: %w", ctx.Err())
		}
		if sctx.Err() != nil {
			return res, errStepTimeout
		}
	}
	return res, err
}

func lastLine(res proc.Result) string {
	for i := len(res.StderrTail) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(res.StderrTail[i]); l != "" {
			return l
		}
	}
	return ""
}

// toolError turns a tool failure into a user-facing error.
func toolError(name string, res proc.Result, err error) error {
	if errors.Is(err, errStepTimeout) {
		return core.Errorf(core.CodeToolFailed, "%s took too long", name).
			WithHint("Try again, or raise the timeout in Advanced")
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return fmt.Errorf("run %s: %w", name, err)
	}
	msg := lastLine(res)
	if msg == "" {
		msg = fmt.Sprintf("%s exited with code %d", name, res.ExitCode)
	}
	return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	opts = withDefaults(opts)
	if len(job.Inputs) == 0 {
		return core.ValidationError("No link to archive", nil)
	}
	monolith, err := job.Tool(deps.Monolith)
	if err != nil {
		return err
	}
	var browser string
	if opts.RenderJS || opts.AlsoPDF {
		browser, _ = m.browser()
		if browser == "" {
			return core.ValidationError("No browser found", nil).WithHint(browserHint())
		}
	}

	total := len(job.Inputs)
	sum := Summary{Results: make([]URLResult, 0, total)}
	saved := 0
	var firstErr error
	titleSet := false

	for i, in := range job.Inputs {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("archive cancelled: %w", err)
		}
		u := strings.TrimSpace(in)
		job.Progress(float64(i)/float64(total), fmt.Sprintf("Saving %d of %d", i+1, total))
		work := filepath.Join(job.TempDir, strconv.Itoa(i))
		res, err := m.archiveOne(ctx, job, opts, monolith, browser, u, work)
		if ctx.Err() != nil {
			return fmt.Errorf("archive cancelled: %w", ctx.Err())
		}
		res.URL = u
		if err != nil {
			res.OK = false
			res.Error = userMessage(err)
			job.Logf("Failed %s: %s", u, res.Error)
			if firstErr == nil {
				firstErr = err
			}
		} else {
			res.OK = true
			saved++
			job.Logf("Saved %s", res.Page)
			if !titleSet {
				titleSet = true
				t := res.Title
				if t == "" {
					t = hostDir(u)
				}
				if total > 1 {
					t = fmt.Sprintf("%s (+%d more)", t, total-1)
				}
				job.SetTitle(t)
			}
		}
		sum.Results = append(sum.Results, res)
	}
	if err := job.SetResult(sum); err != nil {
		job.Logf("Couldn't record the summary: %v", err)
	}

	failed := total - saved
	if saved == 0 {
		if total == 1 {
			return firstErr
		}
		return core.Errorf(core.CodeToolFailed, "None of the %d pages could be saved", total).
			WithHint(userMessage(firstErr)).WithCause(firstErr)
	}
	job.Progress(1, summaryLine(saved, failed))
	if failed > 0 {
		job.Logf("%s", summaryLine(saved, failed))
	}
	return nil
}

func summaryLine(saved, failed int) string {
	if failed == 0 {
		if saved == 1 {
			return "Saved 1 page"
		}
		return fmt.Sprintf("Saved %d pages", saved)
	}
	return fmt.Sprintf("Saved %d of %d pages, %d failed", saved, saved+failed, failed)
}

func userMessage(err error) string {
	if ae := core.AsAppError(err); ae != nil && ae.Message != "" {
		return ae.Message
	}
	return err.Error()
}

// archiveOne saves one URL. The returned result carries what was saved even
// when err is non-nil only for the PDF part (PDFErr), never partially.
func (m *Module) archiveOne(ctx context.Context, job *core.JobContext, o Options, monolith, browser, u, work string) (URLResult, error) {
	var res URLResult
	if msg := checkURL(u, o.AllowLocal); msg != "" {
		return res, core.ValidationError(msg, nil)
	}
	if err := m.checkResolved(ctx, u, o.AllowLocal); err != nil {
		return res, err
	}
	if err := os.MkdirAll(work, 0o755); err != nil {
		return res, fmt.Errorf("create work dir: %w", err)
	}
	budget := stepBudget(o.TimeoutSec)
	page := filepath.Join(work, "page.html")

	source, rendered := u, false
	if o.RenderJS {
		job.Logf("Rendering %s", u)
		if err := m.dumpDOM(ctx, budget, browser, filepath.Join(work, "profile-dom"), u, filepath.Join(work, "dom.html")); err != nil {
			return res, err
		}
		source, rendered = "dom.html", true
	}
	job.Logf("Saving %s", u)
	r, err := runStep(ctx, budget, proc.Spec{
		Path:     monolith,
		Args:     monolithArgs(source, page, u, rendered, o),
		Dir:      work,
		OnStderr: func(l string) { job.Log(core.StreamStderr, l) },
	})
	if err != nil {
		return res, toolError("monolith", r, err)
	}
	if st, err := os.Stat(page); err != nil || st.Size() == 0 {
		return res, core.Errorf(core.CodeToolFailed, "monolith finished without producing a page")
	}

	res.Title = pageTitle(page)
	stem := baseName(res.Title, hostDir(u), m.now())
	dir := filepath.Join(job.OutputDir, hostDir(u))
	dst, err := placeFile(page, dir, stem, ".html")
	if err != nil {
		return res, fmt.Errorf("save page: %w", err)
	}
	if _, err := job.Output(dst); err != nil {
		return res, fmt.Errorf("register page: %w", err)
	}
	res.Page = dst

	if o.AlsoPDF {
		pdf := filepath.Join(work, "page.pdf")
		pr, perr := runStep(ctx, budget, proc.Spec{
			Path: browser,
			Args: pdfArgs(filepath.Join(work, "profile-pdf"), pdf, u),
			Dir:  work,
		})
		if perr == nil {
			if st, serr := os.Stat(pdf); serr != nil || st.Size() == 0 {
				perr = core.Errorf(core.CodeToolFailed, "The browser finished without producing a PDF")
			}
		} else {
			perr = toolError("browser", pr, perr)
		}
		if ctx.Err() != nil {
			return res, fmt.Errorf("cancelled: %w", ctx.Err())
		}
		if perr == nil {
			pstem := strings.TrimSuffix(filepath.Base(dst), ".html")
			if pdst, err := placeFile(pdf, dir, pstem, ".pdf"); err != nil {
				perr = fmt.Errorf("save pdf: %w", err)
			} else if _, err := job.Output(pdst); err != nil {
				perr = fmt.Errorf("register pdf: %w", err)
			} else {
				res.PDF = pdst
			}
		}
		if perr != nil {
			// The page itself was saved, so the URL still counts as saved.
			res.PDFErr = userMessage(perr)
			job.Logf("PDF failed for %s: %s", u, res.PDFErr)
		}
	}
	return res, nil
}

// dumpDOM runs the browser's --dump-dom and writes its stdout to out.
func (m *Module) dumpDOM(ctx context.Context, budget time.Duration, browser, profile, u, out string) error {
	f, err := os.Create(out)
	if err != nil {
		return fmt.Errorf("create dom file: %w", err)
	}
	w := bufio.NewWriter(f)
	r, rerr := runStep(ctx, budget, proc.Spec{
		Path: browser,
		Args: domArgs(profile, u),
		Dir:  filepath.Dir(out),
		OnStdout: func(l string) {
			_, _ = w.WriteString(l)
			_ = w.WriteByte('\n')
		},
	})
	ferr := w.Flush()
	if cerr := f.Close(); ferr == nil {
		ferr = cerr
	}
	if rerr != nil {
		return toolError("browser", r, rerr)
	}
	if ferr != nil {
		return fmt.Errorf("write dom file: %w", ferr)
	}
	if st, err := os.Stat(out); err != nil || st.Size() == 0 {
		return core.Errorf(core.CodeToolFailed, "The browser returned an empty page")
	}
	return nil
}
