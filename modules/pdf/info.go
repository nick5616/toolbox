package pdf

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"

	"toolbox/core"
)

func isPasswordErr(err error) bool {
	return errors.Is(err, pdfcpu.ErrWrongPassword) || errors.Is(err, pdfcpu.ErrOwnerPasswordRequired) ||
		(err != nil && strings.Contains(strings.ToLower(err.Error()), "password"))
}

// statPDF checks that path is a readable, supported-size file.
func statPDF(path string) (os.FileInfo, error) {
	fi, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, core.Errorf(core.CodeNotFound, "File not found: %s", path).WithCause(err)
		}
		return nil, fmt.Errorf("stat %s: %w", path, err)
	}
	if fi.IsDir() {
		return nil, core.ValidationError("This is a folder, not a PDF", nil)
	}
	if fi.Size() > MaxInputBytes {
		return nil, core.ValidationError("PDFs over 500 MB aren't supported", nil)
	}
	return fi, nil
}

// readInfo reads and validates the document. A missing password is not an
// error: it yields NeedsPassword.
func (m *Module) info(ctx context.Context, path string, password string) (Info, error) {
	fi, err := statPDF(path)
	if err != nil {
		return Info{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return Info{}, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	out := Info{Path: path, Bytes: fi.Size(), PageSizes: []PageSize{}}
	xctx, err := api.ReadContext(ctx, f, conf(password))
	if err == nil {
		err = api.ValidateContext(ctx, xctx)
	}
	if err != nil {
		if ctx.Err() != nil {
			return Info{}, ctx.Err()
		}
		if isPasswordErr(err) && password == "" {
			out.Encrypted, out.NeedsPassword = true, true
			return out, nil
		}
		return Info{}, mapErr(ctx, err, password)
	}

	out.Pages = xctx.PageCount
	out.Encrypted = xctx.Encrypt != nil
	out.HasBookmarks = xctx.Outlines != nil
	out.Title = xctx.Title
	dims, err := xctx.PageDims(ctx)
	if err != nil {
		return Info{}, mapErr(ctx, err, password)
	}
	for _, d := range dims {
		out.PageSizes = append(out.PageSizes, PageSize{W: d.Width, H: d.Height})
	}
	if xctx.E != nil {
		out.Restricted = restricted(ctx, f, xctx.E, password)
	}
	return out, nil
}

// restricted reports whether the owner-password permissions block editing
// for the given password.
func restricted(ctx context.Context, f *os.File, e *model.Enc, password string) bool {
	modify := 0x0008
	if e.R >= 3 {
		modify = 0x0400
	}
	if e.P&modify != 0 {
		return false
	}
	if password == "" {
		return true // pdfcpu skips permission checks without any password
	}
	// With a password, ask pdfcpu whether it grants a modifying command.
	if _, err := f.Seek(0, 0); err != nil {
		return true
	}
	c := conf(password)
	c.Cmd = model.ROTATE
	_, err := api.ReadContext(ctx, f, c)
	return errors.Is(err, pdfcpu.ErrPermissionDenied)
}
