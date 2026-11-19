package api

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
	"toolbox/core/focus"
	"toolbox/core/lan"
	"toolbox/core/viz"
)

// Typed event registration. The binding generator reads these calls and
// emits TS types for event payloads. Names must match core/events.go.
func init() {
	application.RegisterEvent[core.Job]("jobs:changed")
	application.RegisterEvent[core.JobsRemoved]("jobs:removed")
	application.RegisterEvent[core.JobProgress]("jobs:progress")
	application.RegisterEvent[core.JobLogBatch]("jobs:log")
	application.RegisterEvent[core.Output]("library:added")
	application.RegisterEvent[core.OutputsRemoved]("library:removed")
	application.RegisterEvent[core.DepsChanged]("deps:changed")
	application.RegisterEvent[core.Settings]("settings:changed")
	application.RegisterEvent[core.FilesDropped]("app:files-dropped")
	application.RegisterEvent[core.Navigate]("app:navigate")

	application.RegisterEvent[core.ClipItem]("clipboard:added")
	application.RegisterEvent[core.ClipsRemoved]("clipboard:removed")
	application.RegisterEvent[core.ClipboardState]("clipboard:state")
	application.RegisterEvent[core.HotkeysChanged]("hotkeys:status")
	application.RegisterEvent[core.ShowView]("window:show")
	application.RegisterEvent[core.HiddenToTray]("app:hidden-to-tray")

	application.RegisterEvent[core.ChatDelta]("chat:delta")
	application.RegisterEvent[core.ChatDone]("chat:done")
	application.RegisterEvent[core.ChatStatus]("chat:status")
	application.RegisterEvent[core.VaultState]("vault:state")
	application.RegisterEvent[core.PacksChanged]("packs:changed")

	application.RegisterEvent[core.PipelinesChanged]("pipelines:changed")
	application.RegisterEvent[core.PipelineRun]("pipelines:run")
	application.RegisterEvent[core.RunsRemoved]("pipelines:runs-removed")

	application.RegisterEvent[core.WindowsChanged]("windows:changed")
	application.RegisterEvent[core.WindowRelay]("windows:relay")
	application.RegisterEvent[core.WindowHandoff]("windows:handoff")

	application.RegisterEvent[lan.State](lan.EventState)
	application.RegisterEvent[lan.DevicesChanged](lan.EventDevices)
	application.RegisterEvent[lan.Prompt](lan.EventPrompt)
	application.RegisterEvent[lan.PromptClosed](lan.EventPromptClose)
	application.RegisterEvent[lan.Message](lan.EventMessage)
	application.RegisterEvent[lan.Activity](lan.EventActivity)
	application.RegisterEvent[focus.State](focus.EventChanged)
	application.RegisterEvent[focus.BlockEvent](focus.EventBlocked)

	application.RegisterEvent[viz.RenderStart]("viz:render")
	application.RegisterEvent[viz.RenderAck]("viz:render-ack")
	application.RegisterEvent[viz.RenderCancel]("viz:render-cancel")

	application.RegisterEvent[core.SearchStatus]("search:status")
	application.RegisterEvent[core.SearchIndexed]("search:indexed")
	application.RegisterEvent[core.SearchReady]("search:ready")
}

// Emitter adapts the Wails event manager to core.Emitter.
type Emitter struct {
	App *application.App
}

// Emit implements core.Emitter.
func (e Emitter) Emit(name string, data any) {
	if e.App != nil {
		e.App.Event.Emit(name, data)
	}
}
