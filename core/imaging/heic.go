package imaging

import (
	"context"
	"sync/atomic"

	"toolbox/core"
)

// HEICConverter turns a HEIC/HEIF photo into an upright PNG (core/heic
// implements it: FFmpeg first, the AI engine as a fallback). main.go
// registers one with SetHEICConverter; every reader in this package and the
// modules that use ToReadable then handle HEIC like any other photo.
type HEICConverter interface {
	ToPNG(ctx context.Context, path string) (string, error)
	// Available reports whether a conversion can be attempted (FFmpeg or the
	// AI engine is installed).
	Available() bool
}

var heicConv atomic.Pointer[HEICConverter]

// SetHEICConverter registers the converter (nil removes it).
func SetHEICConverter(c HEICConverter) {
	if c == nil {
		heicConv.Store(nil)
		return
	}
	heicConv.Store(&c)
}

// HEICAvailable reports whether HEIC photos can be read right now.
func HEICAvailable() bool {
	c := heicConv.Load()
	return c != nil && (*c).Available()
}

// ToReadable returns path itself, or for HEIC/HEIF the cached upright PNG
// (converted on first use). Without a converter HEIC fails with
// CodeDependencyMissing.
func ToReadable(ctx context.Context, path string) (string, error) {
	if !IsHEIC(path) {
		return path, nil
	}
	c := heicConv.Load()
	if c == nil {
		return "", core.Errorf(core.CodeDependencyMissing, "Couldn't read this HEIC photo").
			WithHint("Install the Media pack (FFmpeg) or the Image pack in Settings → Tool packs")
	}
	return (*c).ToPNG(ctx, path)
}
