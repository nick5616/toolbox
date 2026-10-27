// Package api holds the thin Wails services the frontend calls. All logic
// lives in core and modules; these types only adapt and delegate.
package api

import (
	"encoding/json"
	"log/slog"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
)

// MarshalError converts any error returned by a bound method into the
// AppError JSON shape the frontend expects (see frontend/src/lib/errors.ts).
func MarshalError(err error) []byte {
	ae := core.AsAppError(err)
	if ae.Code == core.CodeInternal || ae.Err != nil {
		slog.Error("bound call failed", "code", ae.Code, "message", ae.Message, "err", err)
	}
	b, mErr := json.Marshal(ae)
	if mErr != nil {
		return nil
	}
	return b
}

// Options returns the service options every bound service uses.
func Options() application.ServiceOptions {
	return application.ServiceOptions{MarshalError: MarshalError}
}
