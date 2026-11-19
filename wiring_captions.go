package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/modules/captions"
)

// Caption Writer's event lives with its module (api never imports modules).
func init() {
	application.RegisterEvent[captions.ItemEvent](captions.EventItem)
}
