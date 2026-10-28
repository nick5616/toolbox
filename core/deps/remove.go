package deps

import (
	"context"
	"os"
	"path/filepath"

	"toolbox/core"
)

// RemoveManaged deletes the app-managed copy of a dependency: the archive
// folder (FFmpeg, Deno, ExifTool, the upscaler, …) or the single binary under
// the bin dir. A system copy is never touched, and then takes over. It then
// re-detects. Removing something that isn't installed is not an error.
func (s *Service) RemoveManaged(depID string) error {
	sp, ok := s.spec(depID)
	if !ok {
		return core.Errorf(core.CodeNotFound, "Unknown dependency %q", depID)
	}
	if !sp.Managed || s.binDir == "" {
		return core.Errorf(core.CodeValidation, "%s isn't managed by Toolbox", sp.Name)
	}
	var targets []string
	if sp.ArchiveDir != "" {
		dir := filepath.Join(s.binDir, sp.ArchiveDir)
		targets = []string{dir, dir + ".new", dir + ".old", dir + ".extract"}
	} else {
		targets = []string{filepath.Join(s.binDir, s.exeName(sp.Binary))}
	}
	for _, t := range targets {
		if err := os.RemoveAll(t); err != nil {
			return core.Errorf(core.CodeConflict, "Couldn't remove %s; wait for running tasks to finish and try again", sp.Name).
				WithCause(err)
		}
	}
	s.Detect(context.Background())
	return nil
}
