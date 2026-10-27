package main

import (
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
)

// setupMenu installs the macOS application menu. The Edit menu is required
// for copy/paste to work in the macOS webview. Windows keeps a plain frame
// with no menu bar; shortcuts there are handled by the frontend.
func setupMenu(app *application.App, em core.Emitter) {
	if runtime.GOOS != "darwin" {
		return
	}
	menu := app.Menu.New()

	appMenu := menu.AddSubmenu("Toolbox")
	appMenu.AddRole(application.About)
	appMenu.AddSeparator()
	appMenu.Add("Settings…").SetAccelerator("CmdOrCtrl+,").OnClick(func(*application.Context) {
		em.Emit(core.EventNavigate, core.Navigate{Target: "settings"})
	})
	appMenu.AddSeparator()
	appMenu.AddRole(application.Hide)
	appMenu.AddRole(application.HideOthers)
	appMenu.AddRole(application.UnHide)
	appMenu.AddSeparator()
	appMenu.AddRole(application.Quit)

	menu.AddRole(application.EditMenu)
	menu.AddRole(application.WindowMenu)

	app.Menu.SetApplicationMenu(menu)
}
