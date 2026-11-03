package editstudio

import (
	"context"

	"toolbox/core"
)

// The export's audio mix (SPEC.md §12.3). WP-ES8.

// mixAudio writes the song (range, gain, fades) plus clip audio as a WAV of
// exactly D ms to dst.
func (m *Module) mixAudio(ctx context.Context, job *core.JobContext, doc EditProject, ffmpeg, dst string) error {
	return notBuilt("Audio mix")
}
