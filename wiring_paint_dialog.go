package main

import (
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/modules/paint"
)

// paintSaveDialog is Paint+'s "Export as…" dialog (modules never import Wails).
func paintSaveDialog(title, filename string) (string, error) {
	p, err := application.Get().Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		CanCreateDirectories: true,
		Title:                title,
		Filename:             filename,
		ButtonText:           "Save",
	}).PromptForSingleSelection()
	if err != nil {
		return "", fmt.Errorf("save dialog: %w", err)
	}
	return p, nil
}

// paintBrushDialogs are Paint+'s brush import/export file dialogs.
func paintBrushDialogs() paint.BrushDialogs {
	return paint.BrushDialogs{
		Open: func() ([]string, error) {
			return application.Get().Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
				CanChooseFiles: true, AllowsMultipleSelection: true, Title: "Import brushes", ButtonText: "Import",
				Filters: []application.FileFilter{{DisplayName: "Brush files", Pattern: "*.brushset;*.brush;*.myb;*.abr;*.bundle;*.paintplus-brushes"}},
			}).PromptForMultipleSelection()
		},
		Save: func(name string) (string, error) {
			return application.Get().Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
				CanCreateDirectories: true, Title: "Export brush set", Filename: name, ButtonText: "Export",
			}).PromptForSingleSelection()
		},
	}
}
