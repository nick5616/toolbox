package exif

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// FOUNDATION STUB: WP-EX1 implements these (SPEC.md §6.1–6.3).

var errTODO = core.Errorf(core.CodeInternal, "EXIF isn't implemented yet")

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	_, err := core.DecodeOptionsJSON[Options](options)
	return err
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error { return errTODO }

func (m *Module) read(ctx context.Context, path string) (MetadataView, error) {
	return MetadataView{}, errTODO
}

// session is the long-lived `exiftool -stay_open True -@ -` process.
type session struct {
	exe func() (string, error)
}

func newSession(exe func() (string, error)) *session { return &session{exe: exe} }

// Close stops the process if running.
func (s *session) Close() {}
