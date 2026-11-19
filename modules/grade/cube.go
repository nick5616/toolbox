package grade

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"toolbox/core"
)

// Export .cube (SPEC §E1, §E3.3): the frontend bakes a size³ lattice through
// the colour-only ops and sends the floats; Go validates and writes the file.

// Cube sizes.
const (
	MinCubeSize = 2
	MaxCubeSize = 65
)

// fileStem makes a name safe as a file name on Windows and macOS.
func fileStem(name, fallback string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, strings.TrimSpace(name))
	name = strings.Trim(name, " .")
	if name == "" {
		return fallback
	}
	return name
}

// WriteCube writes a .cube file for a size³ lattice of RGB floats (red index
// fastest, values 0..1).
func WriteCube(w io.Writer, title string, size int, data []float64) error {
	if size < MinCubeSize || size > MaxCubeSize {
		return core.ValidationError(fmt.Sprintf("A LUT is %d to %d points per side", MinCubeSize, MaxCubeSize), map[string]string{"size": "Out of range"})
	}
	if want := size * size * size * 3; len(data) != want {
		return core.ValidationError(fmt.Sprintf("A %d-point LUT has %d numbers, not %d", size, want, len(data)), map[string]string{"data": "Wrong length"})
	}
	bw := bufio.NewWriter(w)
	title = strings.ReplaceAll(strings.ReplaceAll(title, `"`, ""), "\n", " ")
	fmt.Fprintf(bw, "TITLE \"%s\"\nLUT_3D_SIZE %d\nDOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\n", title, size)
	for i := 0; i < len(data); i += 3 {
		for c := 0; c < 3; c++ {
			v := data[i+c]
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return core.ValidationError("The LUT has a number that isn't a number", map[string]string{"data": "Not finite"})
			}
			if c > 0 {
				bw.WriteByte(' ')
			}
			bw.WriteString(strconv.FormatFloat(clamp(v, 0, 1), 'f', 6, 64))
		}
		bw.WriteByte('\n')
	}
	return bw.Flush()
}

// SaveCube writes <library>/Graded/LUTs/<name>.cube and returns its path.
func (m *Module) SaveCube(ctx context.Context, name string, size int, data []float64) (string, error) {
	if m.cfg.LibraryDir == nil || m.cfg.LibraryDir() == "" {
		return "", core.Errorf(core.CodeInternal, "The library folder isn't available")
	}
	dir := filepath.Join(m.cfg.LibraryDir(), "Graded", "LUTs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't create the LUTs folder").WithCause(err)
	}
	path := core.UniquePath(dir, fileStem(name, "Look"), ".cube")
	part := path + ".part"
	f, err := os.Create(part)
	if err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't save the LUT").WithCause(err)
	}
	err = WriteCube(f, strings.TrimSuffix(filepath.Base(path), ".cube"), size, data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(part, path)
	}
	if err != nil {
		_ = os.Remove(part)
		return "", err
	}
	if m.cfg.Outputs != nil {
		fi, serr := os.Stat(path)
		if serr == nil {
			_, _ = m.cfg.Outputs.UpsertOutput(ctx, core.Output{
				ModuleID: ModuleID, Path: path, Name: filepath.Base(path), Kind: core.KindOther,
				SizeBytes: fi.Size(), CreatedAt: time.Now().UnixMilli(),
			})
		}
	}
	return path, nil
}
