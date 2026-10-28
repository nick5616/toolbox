package pdf

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"

	"toolbox/core"
)

func init() {
	// pdfcpu would otherwise create <user config dir>/pdfcpu on first use.
	api.DisableConfigDir()
}

// Messages shared by validation and run.
const (
	msgDamaged       = "This PDF is damaged and couldn't be read"
	msgWrongPassword = "Wrong password"
	msgNeedPassword  = "This PDF needs a password"
	msgRestricted    = "This PDF's permissions block editing"
	hintRestricted   = "Enter its owner password"
)

// conf returns a stateless pdfcpu configuration that opens documents with
// password (as both user and owner password) and repairs common damage.
func conf(password string) *model.Configuration {
	c := model.NewStatelessConfiguration()
	c.UserPW = password
	c.OwnerPW = password
	c.ValidationMode = model.ValidationRelaxed
	return c
}

// mapErr turns a pdfcpu error into a user-facing AppError. Context errors
// pass through unchanged so the job manager reports a cancellation.
func mapErr(ctx context.Context, err error, password string) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var ae *core.AppError
	if errors.As(err, &ae) {
		return err
	}
	pwErr := func() error {
		if password == "" {
			return core.ValidationError(msgNeedPassword, nil).WithCause(err)
		}
		return core.ValidationError(msgWrongPassword, nil).WithCause(err)
	}
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	case errors.Is(err, pdfcpu.ErrWrongPassword), errors.Is(err, pdfcpu.ErrOwnerPasswordRequired):
		return pwErr()
	case errors.Is(err, pdfcpu.ErrPermissionDenied):
		return core.ValidationError(msgRestricted, nil).WithHint(hintRestricted).WithCause(err)
	case errors.Is(err, os.ErrNotExist):
		return core.Errorf(core.CodeNotFound, "File not found").WithCause(err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "password") {
		return pwErr()
	}
	return core.ValidationError(msgDamaged, nil).WithCause(err)
}

// removePartial deletes partly written outputs after a failed or cancelled call.
func removePartial(paths ...string) {
	for _, p := range paths {
		_ = os.Remove(p)
	}
}
