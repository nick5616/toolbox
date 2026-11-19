package mediaindex

import (
	"context"

	"toolbox/core"
)

// CONTRACT STUB (Wave 0): S3 implements the media-index batch here (prepare,
// embed, text gate, OCR, StoreBatch; SPEC.md §3.3) and media-speech in
// speech.go.

func (m *IndexModule) run(ctx context.Context, job *core.JobContext) error {
	return core.Errorf(core.CodeNotImplemented, "Smart search indexing isn't ready yet")
}

func (m *SpeechModule) run(ctx context.Context, job *core.JobContext) error {
	return core.Errorf(core.CodeNotImplemented, "Smart search listening isn't ready yet")
}
