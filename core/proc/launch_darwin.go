//go:build darwin

package proc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// launch runs `open -a <bundle>`. macOS doesn't say which process it started,
// so PID is 0 and closing goes through the bundle path (SPEC.md §1.7).
func launch(ctx context.Context, s LaunchSpec) (Launched, error) {
	if !strings.HasSuffix(strings.ToLower(filepath.Clean(s.Path)), ".app") {
		return Launched{}, errors.New("on the Mac, pick an application (.app)")
	}
	cmd := exec.CommandContext(ctx, "open", macOpenArgs(s)...)
	if s.Dir != "" {
		cmd.Dir = s.Dir
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			msg := strings.TrimSpace(stderr.String())
			if msg == "" {
				msg = "open failed"
			}
			return Launched{}, fmt.Errorf("%s: %w", msg, &ExitedEarlyError{Code: ee.ExitCode()})
		}
		return Launched{}, fmt.Errorf("starting open: %w", err)
	}
	return Launched{}, nil
}
