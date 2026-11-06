//go:build darwin

package proc

import (
	"context"
	"errors"
)

// launch: Wave 0 stub; WP-O1 implements it (SPEC.md §4.2).
func launch(ctx context.Context, s LaunchSpec) (Launched, error) {
	return Launched{}, errors.New("launching apps isn't implemented yet")
}
