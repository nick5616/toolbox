//go:build !windows && !darwin

package proc

import (
	"context"
	"errors"
)

func launch(ctx context.Context, s LaunchSpec) (Launched, error) {
	return Launched{}, errors.New("opening apps isn't supported on this OS")
}
