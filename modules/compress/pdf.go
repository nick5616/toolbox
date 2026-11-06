package compress

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/modules/pdf"
)

// pdfLevel is one rung of the PDF ladder (picture resolution and JPEG quality).
type pdfLevel struct{ DPI, Quality int }

// pdfLadder goes from the gentlest to the hardest level.
var pdfLadder = []pdfLevel{{220, 82}, {150, 70}, {110, 55}, {90, 45}, {72, 35}, {50, 25}}

// ladderGrade grades a ladder level: 0 great, 1 good, 2-3 fair, 4-5 poor.
func ladderGrade(idx int) Grade {
	switch {
	case idx <= 0:
		return GradeGreat
	case idx == 1:
		return GradeGood
	case idx <= 3:
		return GradeFair
	}
	return GradePoor
}

// searchLadder binary-searches levels 0..n-1 (sizes shrink as the index
// grows) for the gentlest one for which fits(i) is true. It returns -1 when
// none fits; in that case level n-1 has been tried.
func searchLadder(n int, fits func(i int) (bool, error)) (int, error) {
	lo, hi, best := 0, n-1, -1
	for lo <= hi {
		mid := (lo + hi) / 2
		ok, err := fits(mid)
		if err != nil {
			return -1, err
		}
		if ok {
			best, hi = mid, mid-1
		} else {
			lo = mid + 1
		}
	}
	return best, nil
}

func pdfPlan(l pdfLevel) string {
	return fmt.Sprintf("Pictures at %d dpi, quality %d", l.DPI, l.Quality)
}

// lockedPDF maps pdf's password/permission errors to "This PDF is locked".
func lockedPDF(err error) error {
	ae := core.AsAppError(err)
	if ae == nil || ae.Code != core.CodeValidation {
		return err
	}
	m := strings.ToLower(ae.Message)
	if strings.Contains(m, "password") || strings.Contains(m, "permission") {
		return core.Errorf(core.CodeValidation, "This PDF is locked").WithHint("Unlock it with PDF Toolkit first").WithCause(err)
	}
	return err
}

// runPDF recompresses the pictures of a PDF, as gently as the limit allows.
func runPDF(ctx context.Context, job *core.JobContext, in input) (Result, error) {
	budget := Budget(in.Limit)
	steps := 1
	for n := len(pdfLadder); n > 1; n /= 2 {
		steps++
	}
	done := 0
	smallest := int64(math.MaxInt64)
	attempts := 0
	paths := map[int]string{}
	idx, err := searchLadder(len(pdfLadder), func(i int) (bool, error) {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		lvl := pdfLadder[i]
		out := filepath.Join(job.TempDir, fmt.Sprintf("pdf-%d.pdf", i))
		base := float64(done) / float64(steps)
		_, err := pdf.CompressImages(ctx, in.Path, out, "", lvl.DPI, lvl.Quality, func(d, total int) {
			if total > 0 {
				job.Progress(math.Min(base+float64(d)/float64(total)/float64(steps), 0.99), pdfPlan(lvl))
			}
		})
		done++
		attempts++
		if err != nil {
			return false, lockedPDF(err)
		}
		size, err := fileSize(out)
		if err != nil {
			return false, err
		}
		smallest = min(smallest, size)
		if size <= budget {
			paths[i] = out
			return true, nil
		}
		_ = os.Remove(out)
		return false, nil
	})
	if err != nil {
		return Result{}, err
	}
	if idx < 0 {
		return Result{}, overLimit(smallest, in.Limit, "Most of this PDF is text and fonts, so it can't get much smaller")
	}
	out, err := saveOutput(job, paths[idx], OutputName(in.Path), ".pdf")
	if err != nil {
		return Result{}, err
	}
	return Result{Outputs: []string{out}, Plan: pdfPlan(pdfLadder[idx]), Grade: ladderGrade(idx), Attempts: attempts}, nil
}

// estimatePDF can't know without trying: it depends on how much is pictures.
func estimatePDF(ctx context.Context, tool toolFunc, in input) Estimate {
	return Estimate{
		Possible: true, Plan: "Recompresses its pictures until it fits", Grade: GradeNone,
		Note: "PDF results depend on how much of it is pictures",
	}
}
