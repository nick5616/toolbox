package pdf

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"

	"toolbox/core"
)

// merge: one job, all inputs in the given order.
func (r *runner) merge(ctx context.Context) error {
	orig := r.job.Inputs
	inputs := make([]string, len(orig))
	total := 0
	for i, in := range orig {
		r.job.Progress(0.4*float64(i)/float64(len(orig)), fmt.Sprintf("Reading %d of %d", i+1, len(orig)))
		info, err := r.open(ctx, in, false)
		if err != nil {
			return err
		}
		total += info.Pages
		inputs[i] = in
		if info.Encrypted {
			// pdfcpu refuses to merge encrypted files: merge decrypted copies.
			dir, err := r.scratch()
			if err != nil {
				return err
			}
			inputs[i] = filepath.Join(dir, "in.pdf")
			if err := api.DecryptFile(ctx, in, inputs[i], conf(r.password)); err != nil {
				return r.failed(ctx, err, inputs[i])
			}
		}
	}
	out := r.outPath(core.StemName(orig[0]), " (merged)")
	r.job.Progress(core.IndeterminateProgress, "Merging")
	if err := api.MergeCreateFile(ctx, inputs, out, false, conf("")); err != nil {
		return r.failed(ctx, err, out)
	}
	r.res.Pages = total
	r.job.Progress(1, fmt.Sprintf("Merged %d PDFs · %d pages", len(inputs), total))
	return r.register(out)
}

var splitNum = regexp.MustCompile(`(\d+)(?:-(\d+))?$`)

// split: one job per input.
func (r *runner) split(ctx context.Context) error {
	in := r.job.Inputs[0]
	info, err := r.open(ctx, in, false)
	if err != nil {
		return err
	}
	stem := core.StemName(in)
	c := conf(r.password)
	var made []string
	fail := func(err error) error { return r.failed(ctx, err, made...) }

	if r.opts.SplitMode == SplitEvery {
		dir, err := r.scratch()
		if err != nil {
			return err
		}
		r.job.Progress(core.IndeterminateProgress, "Splitting")
		if err := api.SplitFile(ctx, in, dir, r.opts.Every, c); err != nil {
			return fail(err)
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return fmt.Errorf("list split output: %w", err)
		}
		type part struct {
			path string
			from int
		}
		var parts []part
		for _, e := range entries {
			m := splitNum.FindStringSubmatch(strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())))
			if e.IsDir() || m == nil {
				continue
			}
			from, _ := strconv.Atoi(m[1])
			parts = append(parts, part{filepath.Join(dir, e.Name()), from})
		}
		sort.Slice(parts, func(a, b int) bool { return parts[a].from < parts[b].from })
		for i, p := range parts {
			// pdfcpu numbers files by their first page for span 1 and by index otherwise;
			// recompute the page span from the position instead.
			from := i*r.opts.Every + 1
			to := min(from+r.opts.Every-1, info.Pages)
			dst := r.outPath(stem, " (pages "+pageRange{from, to}.label()+")")
			if err := moveFile(p.path, dst); err != nil {
				return fail(err)
			}
			made = append(made, dst)
			r.job.Progress(float64(i+1)/float64(len(parts)), fmt.Sprintf("Wrote %d of %d", i+1, len(parts)))
		}
	} else {
		ranges, err := parseRanges(r.opts.Ranges, info.Pages)
		if err != nil {
			return fieldErr("ranges", capitalize(err.Error()))
		}
		for i, rg := range ranges {
			dst := r.outPath(stem, " (pages "+rg.label()+")")
			if err := api.CollectFile(ctx, in, dst, []string{rg.label()}, c); err != nil {
				return fail(err)
			}
			made = append(made, dst)
			r.job.Progress(float64(i+1)/float64(len(ranges)), fmt.Sprintf("Wrote %d of %d", i+1, len(ranges)))
		}
	}
	for _, p := range made {
		if err := r.register(p); err != nil {
			return err
		}
	}
	r.res.Pages = info.Pages
	r.res.BookmarksDropped = info.HasBookmarks
	r.job.Progress(1, fmt.Sprintf("%d files%s", len(made), bookmarksNote(info.HasBookmarks)))
	return nil
}

// organize: pick, order and rotate pages of one PDF.
func (r *runner) organize(ctx context.Context) error {
	in := r.job.Inputs[0]
	info, err := r.open(ctx, in, false)
	if err != nil {
		return err
	}
	for _, p := range r.opts.Pages {
		if p.Page > info.Pages {
			return fieldErr("pages", fmt.Sprintf("Page %d doesn't exist (the document has %d)", p.Page, info.Pages))
		}
	}
	dir, err := r.scratch()
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, "organized.pdf")
	sel := make([]string, len(r.opts.Pages))
	for i, p := range r.opts.Pages {
		sel[i] = strconv.Itoa(p.Page)
	}
	c := conf(r.password)
	r.job.Progress(core.IndeterminateProgress, "Collecting pages")
	if err := api.CollectFile(ctx, in, tmp, sel, c); err != nil {
		return r.failed(ctx, err, tmp)
	}
	// Rotations are relative, grouped by angle, on output page numbers.
	groups := map[int][]string{}
	for i, p := range r.opts.Pages {
		if p.Rotate%360 != 0 {
			groups[p.Rotate%360] = append(groups[p.Rotate%360], strconv.Itoa(i+1))
		}
	}
	angles := make([]int, 0, len(groups))
	for a := range groups {
		angles = append(angles, a)
	}
	sort.Ints(angles)
	for _, a := range angles {
		r.job.Progress(core.IndeterminateProgress, "Rotating pages")
		if err := api.RotateFile(ctx, tmp, tmp, a, groups[a], conf(r.password)); err != nil {
			return r.failed(ctx, err, tmp)
		}
	}
	out := r.outPath(core.StemName(in), " (edited)")
	if err := moveFile(tmp, out); err != nil {
		return err
	}
	r.res.Pages = len(r.opts.Pages)
	r.res.BookmarksDropped = info.HasBookmarks
	r.job.Progress(1, fmt.Sprintf("%d pages%s", len(r.opts.Pages), bookmarksNote(info.HasBookmarks)))
	return r.register(out)
}

// compress: recompress the images of one PDF.
func (r *runner) compress(ctx context.Context) error {
	in := r.job.Inputs[0]
	info, err := r.open(ctx, in, false)
	if err != nil {
		return err
	}
	dir, err := r.scratch()
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, "compressed.pdf")
	r.job.Progress(core.IndeterminateProgress, "Reading")
	res, err := compressPDF(ctx, in, tmp, r.password, levelParams(r.opts.Level), func(done, total int) {
		r.job.Progress(0.9*float64(done)/float64(total), fmt.Sprintf("Recompressing images · %d of %d", done, total))
	})
	if err != nil {
		return err
	}
	fi, err := os.Stat(tmp)
	if err != nil {
		return fmt.Errorf("stat compressed output: %w", err)
	}
	r.res.Pages = info.Pages
	r.res.BytesAfter = fi.Size()
	r.res.ImagesRecompressed = res.recompressed
	if float64(fi.Size()) >= alreadyCompactRatio*float64(info.Bytes) {
		r.res.BytesAfter = info.Bytes
		r.job.Progress(1, "Already compact — couldn't make it meaningfully smaller")
		return nil
	}
	out := r.outPath(core.StemName(in), " (compressed)")
	if err := moveFile(tmp, out); err != nil {
		return err
	}
	after := r.res.BytesAfter
	r.job.Progress(1, fmt.Sprintf("%s → %s (−%d%%)", humanBytes(info.Bytes), humanBytes(after), 100-int(100*after/max(info.Bytes, 1))))
	// register adds BytesAfter again, so reset it first.
	r.res.BytesAfter = 0
	return r.register(out)
}

func humanBytes(n int64) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1f MB", float64(n)/1e6)
	case n >= 1_000:
		return fmt.Sprintf("%.0f KB", float64(n)/1e3)
	}
	return fmt.Sprintf("%d B", n)
}

// protect: AES-256 with the new password as user and owner password.
func (r *runner) protect(ctx context.Context) error {
	in := r.job.Inputs[0]
	info, err := r.open(ctx, in, false)
	if err != nil {
		return err
	}
	src := in
	if info.Encrypted {
		// pdfcpu can't re-encrypt an encrypted file: decrypt to scratch first.
		dir, err := r.scratch()
		if err != nil {
			return err
		}
		src = filepath.Join(dir, "plain.pdf")
		if err := api.DecryptFile(ctx, in, src, conf(r.password)); err != nil {
			return r.failed(ctx, err, src)
		}
	}
	c := conf(r.newPassword)
	c.EncryptUsingAES = true
	c.EncryptKeyLength = 256
	c.Permissions = model.PermissionsAll
	out := r.outPath(core.StemName(in), " (protected)")
	r.job.Progress(core.IndeterminateProgress, "Encrypting")
	if err := api.EncryptFile(ctx, src, out, c); err != nil {
		return r.failed(ctx, err, out)
	}
	r.res.Pages = info.Pages
	r.job.Progress(1, "Protected with AES-256")
	return r.register(out)
}

// unlock: remove the password.
func (r *runner) unlock(ctx context.Context) error {
	in := r.job.Inputs[0]
	info, err := r.m.info(ctx, in, r.password)
	if err != nil {
		return err
	}
	if info.NeedsPassword {
		return core.ValidationError(msgWrongPassword, nil)
	}
	if !info.Encrypted {
		return core.ValidationError("This PDF isn't password-protected", nil)
	}
	r.res.BytesBefore = info.Bytes
	out := r.outPath(core.StemName(in), " (unlocked)")
	r.job.Progress(core.IndeterminateProgress, "Unlocking")
	if err := api.DecryptFile(ctx, in, out, conf(r.password)); err != nil {
		return r.failed(ctx, err, out)
	}
	r.res.Pages = info.Pages
	r.job.Progress(1, "Password removed")
	return r.register(out)
}
