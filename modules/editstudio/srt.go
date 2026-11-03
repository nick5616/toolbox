package editstudio

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/modules/subtitles"
)

// Captions as SubRip (SPEC.md §14.9). WP-ES9.

// maxSRTCues bounds an SRT request (SPEC.md §11.7).
const maxSRTCues = 20_000

// writeSRT writes req.Cues (timeline ms) as <name>.srt into the Library
// (job.OutputDir) with subtitles.FormatSRT.
func (m *Module) writeSRT(ctx context.Context, job *core.JobContext, req TextRequest) error {
	if len(req.Cues) == 0 {
		return core.ValidationError("There are no captions to export", nil)
	}
	if len(req.Cues) > maxSRTCues {
		return core.ValidationError("Too many caption lines to export", nil)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	cues := make([]subtitles.Cue, 0, len(req.Cues))
	for _, l := range req.Cues {
		start, end := max(l.StartMs, 0), max(l.EndMs, 0)
		if end < start {
			end = start
		}
		cues = append(cues, subtitles.Cue{StartMs: start, EndMs: end, Text: l.Text})
	}
	dst := core.UniquePath(job.OutputDir, fileStem(req.Name, "Captions"), ".srt")
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("creating the output folder: %w", err)
	}
	if err := os.WriteFile(dst, []byte(subtitles.FormatSRT(cues)), 0o644); err != nil {
		return fmt.Errorf("writing the captions file: %w", err)
	}
	if _, err := job.Output(dst); err != nil {
		return err
	}
	job.Progress(1, "Saved")
	return job.SetResult(Result{Action: ActionText, Outputs: []string{dst}})
}
