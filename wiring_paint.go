package main

import (
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
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
