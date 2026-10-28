package clipboard

import (
	"context"
	"fmt"

	sysclip "golang.design/x/clipboard"

	"toolbox/core"
)

// systemSource is the real OS clipboard (golang.design/x/clipboard v0.11).
// Construction touches nothing; the clipboard is only used after Init.
type systemSource struct{}

func newSystemSource() source { return systemSource{} }

func (systemSource) Init() error { return sysclip.Init() }

func (systemSource) Watch(ctx context.Context, images bool) <-chan change {
	formats := []sysclip.Option{sysclip.FmtText}
	if images {
		formats = append(formats, sysclip.FmtImage)
	}
	in := sysclip.Watch(ctx, formats...)
	out := make(chan change)
	go func() {
		defer close(out)
		for d := range in {
			c := change{Bytes: d.Bytes, Sensitive: d.Sensitive}
			switch d.Format {
			case sysclip.FmtText:
				c.Kind = core.ClipText
			case sysclip.FmtImage:
				c.Kind = core.ClipImage
			default:
				continue
			}
			select {
			case out <- c:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

func (systemSource) Write(ctx context.Context, kind core.ClipKind, data []byte) error {
	var f sysclip.Format
	switch kind {
	case core.ClipText:
		f = sysclip.FmtText
	case core.ClipImage:
		f = sysclip.FmtImage
	default:
		return fmt.Errorf("unsupported clipboard kind %q", kind)
	}
	if _, err := sysclip.Write(ctx, f, data); err != nil {
		return fmt.Errorf("write clipboard: %w", err)
	}
	return nil
}
