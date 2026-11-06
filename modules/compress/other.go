package compress

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"toolbox/core"
)

// otherSample is how much of a file (from the start and from the middle) is
// compressed to predict the zip ratio.
const otherSample = 4 << 20

// newZipWriter is a zip writer that deflates at the best level.
func newZipWriter(w io.Writer) *zip.Writer {
	zw := zip.NewWriter(w)
	zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(w, flate.BestCompression)
	})
	return zw
}

// ctxReader stops a copy when ctx is cancelled and reports progress.
type ctxReader struct {
	ctx      context.Context
	r        io.Reader
	n, total int64
	progress func(float64)
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := c.r.Read(p)
	c.n += int64(n)
	if c.progress != nil && c.total > 0 {
		c.progress(float64(c.n) / float64(c.total))
	}
	return n, err
}

// runOther zips the file at the best deflate level into <name.ext>.zip.
func runOther(ctx context.Context, job *core.JobContext, in input) (Result, error) {
	src, err := os.Open(in.Path)
	if err != nil {
		return Result{}, fmt.Errorf("open %s: %w", in.Path, err)
	}
	defer src.Close()
	fi, err := src.Stat()
	if err != nil {
		return Result{}, fmt.Errorf("stat %s: %w", in.Path, err)
	}
	base := filepath.Base(in.Path)
	tmp := filepath.Join(job.TempDir, "other.zip")
	out, err := os.Create(tmp)
	if err != nil {
		return Result{}, fmt.Errorf("create %s: %w", tmp, err)
	}
	zw := newZipWriter(out)
	w, err := zw.CreateHeader(&zip.FileHeader{Name: base, Method: zip.Deflate, Modified: fi.ModTime()})
	if err == nil {
		_, err = io.Copy(w, &ctxReader{ctx: ctx, r: src, total: fi.Size(), progress: func(p float64) { job.Progress(p, "Zipping…") }})
	}
	if err == nil {
		err = zw.Close()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		return Result{}, fmt.Errorf("zip %s: %w", base, err)
	}
	size, err := fileSize(tmp)
	if err != nil {
		return Result{}, err
	}
	if size > in.Limit {
		return Result{}, overLimit(size, in.Limit, "This kind of file doesn't compress much. Try Local File Transfer to send it instead.")
	}
	final, err := saveOutput(job, tmp, base, ".zip")
	if err != nil {
		return Result{}, err
	}
	return Result{Outputs: []string{final}, Plan: "Zipped", Grade: GradeNone, Attempts: 1}, nil
}

// zipRatio compresses data at the best level and returns compressed/original.
func zipRatio(data []byte) float64 {
	if len(data) == 0 {
		return 1
	}
	var buf bytes.Buffer
	fw, _ := flate.NewWriter(&buf, flate.BestCompression)
	_, _ = fw.Write(data)
	_ = fw.Close()
	return float64(buf.Len()) / float64(len(data))
}

// predictZip is the predicted zip size from a ratio measured on a sample.
func predictZip(size int64, ratio float64) int64 {
	return int64(float64(size)*ratio) + 200
}

// estimateOther predicts the zip size from the first and middle 4 MB.
func estimateOther(ctx context.Context, tool toolFunc, in input) Estimate {
	f, err := os.Open(in.Path)
	if err != nil {
		return Estimate{Problem: "Can't read this file"}
	}
	defer f.Close()
	var sample []byte
	if in.Size <= 2*otherSample {
		sample, err = io.ReadAll(f)
	} else {
		sample = make([]byte, 2*otherSample)
		if _, err = io.ReadFull(f, sample[:otherSample]); err == nil {
			_, err = f.ReadAt(sample[otherSample:], in.Size/2-otherSample/2)
		}
	}
	if err != nil {
		return Estimate{Problem: "Can't read this file"}
	}
	if ctx.Err() != nil {
		return Estimate{Problem: "Cancelled"}
	}
	ratio := zipRatio(sample)
	pred := predictZip(in.Size, ratio)
	est := Estimate{Possible: pred <= Budget(in.Limit), Plan: fmt.Sprintf("Zip (about %d%%)", int(ratio*100+0.5))}
	if !est.Possible {
		est.Note = "This kind of file doesn't compress much"
	}
	return est
}
