package api

import (
	"errors"
	"fmt"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
)

// FilesService lets tools pick and inspect local input files.
type FilesService struct {
	Reg *core.Registry
}

// Pick shows a native multi-select file dialog filtered to the module's
// accepted extensions. Cancelling returns an empty list.
func (s *FilesService) Pick(moduleID string) ([]string, error) {
	d, ok := s.Reg.Descriptor(moduleID)
	if !ok {
		return nil, core.Errorf(core.CodeNotFound, "Unknown module %q", moduleID)
	}
	opts := &application.OpenFileDialogOptions{
		CanChooseFiles:          true,
		AllowsMultipleSelection: true,
		Title:                   "Add files to " + d.Name,
		ButtonText:              "Add",
	}
	if exts := d.Accepts.Extensions; len(exts) > 0 {
		pats := make([]string, len(exts))
		for i, e := range exts {
			pats[i] = "*" + e
		}
		opts.Filters = []application.FileFilter{{
			DisplayName: fmt.Sprintf("%s files (%s)", d.Name, strings.Join(pats, ", ")),
			Pattern:     strings.Join(pats, ";"),
		}}
	}
	paths, err := application.Get().Dialog.OpenFileWithOptions(opts).PromptForMultipleSelection()
	if err != nil {
		if errors.Is(err, errDialogCancelled) {
			return []string{}, nil
		}
		return nil, fmt.Errorf("file dialog: %w", err)
	}
	if paths == nil {
		paths = []string{}
	}
	return paths, nil
}

// errDialogCancelled is never returned by Wails (it returns empty results
// on cancel); kept so the cancel path stays explicit.
var errDialogCancelled = errors.New("cancelled")

// Stat describes paths for input lists.
func (s *FilesService) Stat(paths []string) []core.FileInfo { return core.StatFiles(paths) }
