package converter

import (
	"fmt"

	"toolbox/core"
)

// buildArgs assembles the ffmpeg command line (SPEC.md §5). It is pure. An
// unknown preset yields nil (Validate rejects those earlier).
func buildArgs(opts Options, input, tmpOut string) []string {
	p, ok := lookup(opts.Preset)
	if !ok {
		return nil
	}
	args := []string{"-hide_banner", "-nostdin", "-y", "-i", input}
	if opts.KeepMetadata {
		args = append(args, "-map_metadata", "0")
	} else {
		args = append(args, "-map_metadata", "-1")
	}
	args = append(args, p.Args...)
	if p.Kind == core.KindVideo && opts.MaxHeight != "" && opts.MaxHeight != HeightKeep {
		// The comma inside min() must be escaped for the filtergraph parser;
		// no shell is involved, so this is one literal argument.
		args = append(args, "-vf", fmt.Sprintf(`scale=-2:min(ih\,%s)`, opts.MaxHeight))
	}
	if p.Kind == core.KindImage {
		args = append(args, "-frames:v", "1")
	}
	return append(args, "-progress", "pipe:1", "-nostats", tmpOut)
}
