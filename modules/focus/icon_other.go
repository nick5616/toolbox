//go:build !windows

package focus

import "errors"

// renderIcon: only Windows has an icon API without cgo; elsewhere the UI
// shows a lettered tile.
func renderIcon(string) ([]byte, error) { return nil, errors.New("no icons on this OS") }
