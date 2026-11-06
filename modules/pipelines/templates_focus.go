package pipelines

import (
	"toolbox/core"
	"toolbox/core/focus"
	"toolbox/modules/downloader"
	focusmod "toolbox/modules/focus"
	"toolbox/modules/stems"
)

// Phase 18 templates (SPEC.md §4.4). Their Focus steps leave the profile
// empty (and the Open in app steps the app), so the step editor flags them.
const (
	TplMusicSession  = "music-session"
	TplPomodoro      = "pomodoro"
	TplDeepWork      = "morning-deep-work"
	TplSampleAndMake = "sample-then-make"

	stFocus          = focusmod.ModuleID
	pomodoroRounds   = 4
	pomodoroWorkVar  = "work_minutes"
	pomodoroBreakVar = "break_minutes"
)

func focusStart(minutes int) focusmod.StepOptions {
	o := focusmod.DefaultStepOptions()
	o.Minutes = minutes
	return o
}

func focusWait() focusmod.StepOptions {
	o := focusmod.DefaultStepOptions()
	o.Action = focusmod.ActionWait
	return o
}

// musicSession: a firm 90 minute session with your DAW opened inside it.
func musicSession() core.PipelineTemplate {
	open := DefaultOpen()
	open.Label, open.CloseWhen = "Your DAW", CloseFocusEnds
	return buildTemplate(TplMusicSession, "Music session", "headphones",
		"Start a 90 minute focus session with only your studio apps, open your DAW inside it and close it politely when the time is up. Pick the profile and the program in the steps.",
		[]string{},
		tstep{id: "focus", typ: stFocus, from: "none", opts: focusStart(90)},
		tstep{id: "daw", typ: TypeOpen, from: "none", opts: open},
		tstep{id: "until", typ: stFocus, from: "none", opts: focusWait(), keep: true},
	)
}

// pomodoro: four work rounds with breaks between them, timed by run parameters.
func pomodoro() core.PipelineTemplate {
	var steps []tstep
	for i := 1; i <= pomodoroRounds; i++ {
		n := string(rune('0' + i))
		steps = append(steps,
			tstep{id: "work" + n, typ: stFocus, from: "none", opts: focusStart(25), label: "Work " + n,
				binds: []core.StepBind{{Option: "/minutes", Var: pomodoroWorkVar}}},
			tstep{id: "end" + n, typ: stFocus, from: "none", opts: focusWait(), label: "Work " + n + " ends"},
		)
		if i < pomodoroRounds {
			w := DefaultWait()
			w.Minutes = 5
			steps = append(steps, tstep{id: "break" + n, typ: TypeWait, from: "none", opts: w, label: "Break " + n,
				binds: []core.StepBind{{Option: "/minutes", Var: pomodoroBreakVar}}})
		}
	}
	steps[len(steps)-1].keep = true
	t := buildTemplate(TplPomodoro, "Pomodoro ×4", "timer",
		"Four rounds of focused work with short breaks between them. Set the minutes when you start, and pick a profile in each work step.",
		[]string{}, steps...)
	t.Pipeline.Params = []core.PipelineParam{
		{Name: pomodoroWorkVar, Label: "Work minutes", Type: core.ValueNumber, Default: "25", Choices: []string{}},
		{Name: pomodoroBreakVar, Label: "Break minutes", Type: core.ValueNumber, Default: "5", Choices: []string{}},
	}
	return t
}

// morningDeepWork: weekdays at 09:30, focus until noon. The schedule ships off
// (like a template's watch folder): the profile has to be picked first.
func morningDeepWork() core.PipelineTemplate {
	o := focusmod.DefaultStepOptions()
	o.Mode, o.At, o.Strength = focusmod.ModeUntil, "12:00", focus.StrengthStrict
	t := buildTemplate(TplDeepWork, "Morning deep work", "sun",
		"Every weekday at 09:30, start a strict focus session until noon. Pick a profile, then turn the schedule on.",
		[]string{}, tstep{id: "focus", typ: stFocus, from: "none", opts: o, keep: true})
	t.Pipeline.Schedule = core.ScheduleTrigger{Enabled: false, Days: []int{1, 2, 3, 4, 5}, Times: []string{"09:30"}, CatchUpMin: 30}
	return t
}

// sampleThenMake: sample a song inside a focus session, then open your tool.
func sampleThenMake() core.PipelineTemplate {
	dl := downloader.DefaultOptions()
	dl.Mode, dl.AudioFormat, dl.Playlist = downloader.ModeAudio, downloader.FormatFLAC, false
	st := stems.DefaultOptions()
	st.Preset, st.Format = stems.PresetFourFast, stems.FormatFLAC
	open := DefaultOpen()
	open.Label = "Your music app"
	return buildTemplate(TplSampleAndMake, "Sample, then make something", "audio-waveform",
		"Paste a song link: a two hour focus session starts, the song is downloaded, split into stems and named with its tempo and key, then your music app opens.",
		[]string{"media", "music"},
		tstep{id: "focus", typ: stFocus, from: "none", opts: focusStart(120)},
		tstep{id: "download", typ: stDownloader, from: "input", opts: dl},
		tstep{id: "stems", typ: stStems, opts: st},
		tstep{id: "tempo", typ: stBPMKey, from: "download", opts: struct{}{}},
		tstep{id: "name", typ: TypeRename, from: "stems", opts: RenameStep{Template: "{name} · {bpm} BPM · {key}"}, keep: true},
		tstep{id: "open", typ: TypeOpen, from: "none", opts: open},
	)
}
