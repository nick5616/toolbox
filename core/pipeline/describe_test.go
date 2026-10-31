package pipeline

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
)

func describeEnv(t *testing.T) *env {
	t.Helper()
	e := newEnv(t, 4,
		&fakeStep{id: "a", split: true},
		&fakeStep{id: "b", split: true},
		&fakeStep{id: "txtonly", split: true, accepts: []string{".txt"}},
		&fakeStep{id: "needy", split: true, requires: []string{"ffmpeg", "tool2"}},
		&fakeStep{id: "needy2", split: true, requires: []string{"ffmpeg"}},
		tableStep{})
	must(t, e.reg.RegisterPlaceholder(core.Descriptor{ID: "soon", Name: "Soon", Accepts: core.Accepts{Extensions: []string{".txt"}}}))
	e.start()
	return e
}

func problems(c core.PipelineCheck, i int) []string { return c.Steps[i].Problems }

func hasProblem(c core.PipelineCheck, i int, want string) bool {
	return slices.Contains(c.Steps[i].Problems, want)
}

func TestDescribeStepRules(t *testing.T) {
	flag := filepath.Join(t.TempDir(), "x")
	_ = flag
	cases := []struct {
		name  string
		steps []core.PipelineStep
		step  int
		want  string // an exact problem on the step; "" = no problems on it
	}{
		{"fine", []core.PipelineStep{step("aaaaaaa1", "a", FromInput, fakeOpts{})}, 0, ""},
		{"unknown type", []core.PipelineStep{step("aaaaaaa1", "nosuch", FromInput, fakeOpts{})}, 0, "This step's tool isn't available"},
		{"not ready module", []core.PipelineStep{step("aaaaaaa1", "soon", FromInput, fakeOpts{})}, 0, "Soon isn't available"},
		{"from nothing", []core.PipelineStep{step("aaaaaaa1", "a", "", fakeOpts{})}, 0, "Choose where this step gets its files"},
		{"from missing step", []core.PipelineStep{step("aaaaaaa1", "a", "zzzzzzz9", fakeOpts{})}, 0, "This step reads from a step that doesn't exist"},
		{"from later step", []core.PipelineStep{step("aaaaaaa1", "a", "bbbbbbb2", fakeOpts{}), step("bbbbbbb2", "b", FromInput, fakeOpts{})}, 0, "This step reads from a step that comes after it"},
		{"from itself", []core.PipelineStep{step("aaaaaaa1", "a", "aaaaaaa1", fakeOpts{})}, 0, "This step reads from a step that comes after it"},
		{"none without NoFiles", []core.PipelineStep{step("aaaaaaa1", "a", FromNone, fakeOpts{})}, 0, "Fake a needs files: choose where they come from"},
		{"none with NoFiles", []core.PipelineStep{step("ttttttt1", "table", FromNone, fakeOpts{})}, 0, ""},
		{"manual allowed", []core.PipelineStep{func() core.PipelineStep {
			s := step("aaaaaaa1", "a", FromInput, fakeOpts{})
			s.Manual = true
			return s
		}()}, 0, ""},
		{"unknown variable", []core.PipelineStep{step("aaaaaaa1", "a", FromInput, fakeOpts{Template: "{bpm}"})}, 0, "{bpm} isn't made by an earlier step"},
		{"built-in variables", []core.PipelineStep{step("aaaaaaa1", "a", FromInput, fakeOpts{Template: "{item} {name} {ext} {role} {n} {date} {time} {pipeline}"})}, 0, ""},
		{"literal braces", []core.PipelineStep{step("aaaaaaa1", "a", FromInput, fakeOpts{Template: "{{bpm}}"})}, 0, ""},
		{"earlier step's variable", []core.PipelineStep{
			step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"bpm": "1"}}),
			step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Template: "{bpm}"})}, 1, ""},
		{"own variable isn't available", []core.PipelineStep{
			step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"bpm": "1"}, Template: "{bpm}"})}, 0, "{bpm} isn't made by an earlier step"},
		{"later step's variable", []core.PipelineStep{
			step("aaaaaaa1", "a", FromInput, fakeOpts{Template: "{bpm}"}),
			step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Vars: map[string]string{"bpm": "1"}})}, 0, "{bpm} isn't made by an earlier step"},
		{"file is only for chat", []core.PipelineStep{step("aaaaaaa1", "a", FromInput, fakeOpts{Template: "{file}"})}, 0, "{file} isn't made by an earlier step"},
		{"wildcard pointer", []core.PipelineStep{
			func() core.PipelineStep {
				s := step("ttttttt1", "table", FromNone, fakeOpts{})
				s.OptionsJSON = `{"cols":["{item}","{nope}"]}`
				return s
			}()}, 0, "{nope} isn't made by an earlier step"},
		{"incompatible after pass-through", []core.PipelineStep{
			step("aaaaaaa1", "a", FromInput, fakeOpts{Ext: ".wav"}),
			{ID: "kkkkkkk2", Type: CheckType, From: "aaaaaaa1", OptionsJSON: "{}"},
			step("ccccccc3", "txtonly", "kkkkkkk2", fakeOpts{})}, 2, "Fake txtonly can't read what step 2 makes (.wav)"},
		{"compatible", []core.PipelineStep{
			step("aaaaaaa1", "a", FromInput, fakeOpts{Ext: ".txt"}),
			step("bbbbbbb2", "txtonly", "aaaaaaa1", fakeOpts{})}, 1, ""},
		{"incompatible", []core.PipelineStep{
			step("aaaaaaa1", "a", FromInput, fakeOpts{Ext: ".wav"}),
			step("bbbbbbb2", "txtonly", "aaaaaaa1", fakeOpts{})}, 1, "Fake txtonly can't read what step 1 makes (.wav)"},
		{"filter can rescue compatibility", []core.PipelineStep{
			step("aaaaaaa1", "a", FromInput, fakeOpts{Make: 2, Roles: []string{"A", "B"}, Ext: ".wav"}),
			func() core.PipelineStep {
				s := step("bbbbbbb2", "txtonly", "aaaaaaa1", fakeOpts{})
				s.Filter.Exts = []string{".txt"}
				return s
			}()}, 1, ""},
		{"invalid options", []core.PipelineStep{{ID: "aaaaaaa1", Type: "a", From: FromInput, OptionsJSON: `{"make":"x"}`}}, 0, core.AsAppError(func() error {
			_, err := (&fakeStep{}).DescribeStep([]byte(`{"make":"x"}`))
			return err
		}()).Message},
		{"not json", []core.PipelineStep{{ID: "aaaaaaa1", Type: "a", From: FromInput, OptionsJSON: `{nope`}}, 0, "The options aren't valid"},
	}
	e := describeEnv(t)
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			check := e.r.Describe(pl("P", c.steps...))
			got := problems(check, c.step)
			if c.want == "" {
				if len(got) != 0 {
					t.Fatalf("problems = %q", got)
				}
				return
			}
			if !slices.Contains(got, c.want) {
				t.Fatalf("problems = %q, want %q", got, c.want)
			}
			if check.Ready {
				t.Fatal("Ready with a problem")
			}
		})
	}
}

func TestDescribeFilterRoleWarning(t *testing.T) {
	e := describeEnv(t)
	s2 := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})
	s2.Filter.Roles = []string{"bass", "Vocals"}
	check := e.r.Describe(pl("P", step("aaaaaaa1", "a", FromInput, fakeOpts{Make: 2, Roles: []string{"Vocals", "Drums"}}), s2))
	if !check.Ready || len(check.Steps[1].Problems) != 0 {
		t.Fatalf("a missing role is only a warning: %+v", check.Steps[1].Problems)
	}
	w := check.Steps[1].Info.Warnings
	if len(w) != 1 || !strings.Contains(w[0], `"bass"`) {
		t.Fatalf("warnings = %q", w)
	}
}

func TestDescribeResolvesProducesAndVars(t *testing.T) {
	e := describeEnv(t)
	man := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})
	man.Manual = true
	chk := core.PipelineStep{ID: "kkkkkkk3", Type: CheckType, From: "bbbbbbb2", OptionsJSON: "{}"}
	check := e.r.Describe(pl("P",
		step("aaaaaaa1", "a", FromInput, fakeOpts{Ext: ".wav", Vars: map[string]string{"bpm": "1"}}),
		man, chk,
		step("ddddddd4", "b", "kkkkkkk3", fakeOpts{})))
	if !check.Ready {
		t.Fatalf("not ready: %+v", check)
	}
	for i, sc := range check.Steps {
		if len(sc.Info.Produces) == 0 {
			t.Fatalf("step %d produces nothing", i)
		}
		for _, p := range sc.Info.Produces {
			if p.Kind == "" || p.Exts == nil {
				t.Fatalf("step %d has an unresolved product: %+v", i, p)
			}
		}
	}
	// Pass-through steps (manual, check) make what step 1 makes.
	for _, i := range []int{1, 2} {
		p := check.Steps[i].Info.Produces
		if len(p) != 1 || p[0].Kind != core.KindAudio || !slices.Equal(p[0].Exts, []string{".wav"}) {
			t.Fatalf("step %d produces %+v", i, p)
		}
	}
	// Variables: built-ins plus earlier steps'.
	names := func(i int) []string {
		var out []string
		for _, v := range check.Steps[i].Vars {
			out = append(out, v.Name)
		}
		return out
	}
	for _, b := range []string{"item", "name", "ext", "role", "n", "date", "time", "pipeline"} {
		if !slices.Contains(names(0), b) {
			t.Fatalf("step 1 lacks built-in %s: %v", b, names(0))
		}
	}
	if slices.Contains(names(0), "bpm") || !slices.Contains(names(1), "bpm") || !slices.Contains(names(3), "bpm") {
		t.Fatalf("vars: %v / %v / %v", names(0), names(1), names(3))
	}
}

func TestDescribeAcceptsSecretsMissing(t *testing.T) {
	e := describeEnv(t)
	e.tools = func(id string) (string, error) {
		if id == "ffmpeg" || id == "tool2" {
			return "", errors.New("not installed")
		}
		return "/bin/" + id, nil
	}
	check := e.r.Describe(pl("P",
		step("aaaaaaa1", "txtonly", FromInput, fakeOpts{}),
		step("bbbbbbb2", "needy", "aaaaaaa1", fakeOpts{Secret: true}),
		step("ccccccc3", "needy2", FromInput, fakeOpts{}),
		step("ddddddd4", "a", "bbbbbbb2", fakeOpts{})))
	if !slices.Equal(check.Missing, []string{"ffmpeg", "tool2"}) {
		t.Fatalf("missing = %v", check.Missing)
	}
	if check.Ready {
		t.Fatal("ready with missing tools")
	}
	if len(check.Secrets) != 1 || check.Secrets[0].Label != "Step 2 · Password" || check.Secrets[0].StepID != "bbbbbbb2" || check.Secrets[0].Key != "pw" {
		t.Fatalf("secrets = %+v", check.Secrets)
	}
	// Accepts: union over the steps reading the input (1 and 3), not step 4.
	if !slices.Equal(check.Accepts.Extensions, []string{".txt", ".wav"}) {
		t.Fatalf("accepts = %v", check.Accepts.Extensions)
	}
	e.tools = func(id string) (string, error) { return "/bin/" + id, nil }
	if c := e.r.Describe(pl("P", step("aaaaaaa1", "needy", FromInput, fakeOpts{}))); !c.Ready || len(c.Missing) != 0 {
		t.Fatalf("ready expected: %+v", c)
	}
}

func TestDescribePipelineProblems(t *testing.T) {
	e := describeEnv(t)
	e.save(pl("Taken", step("aaaaaaa1", "a", FromInput, fakeOpts{})))
	one := step("aaaaaaa1", "a", FromInput, fakeOpts{})
	var many []core.PipelineStep
	for i := 0; i < 31; i++ {
		many = append(many, step(string(rune('a'+i%26))+"aaaaaa"+string(rune('a'+i/26)), "a", FromInput, fakeOpts{}))
	}
	big := step("aaaaaaa1", "a", FromInput, fakeOpts{})
	big.OptionsJSON = `{"template":"` + strings.Repeat("x", MaxOptionsBytes) + `"}`
	cases := []struct {
		name string
		p    core.Pipeline
		want string
	}{
		{"empty name", pl("  ", one), "Give the pipeline a name"},
		{"long name", pl(strings.Repeat("n", 81), one), "The name is too long (80 characters at most)"},
		{"duplicate name", pl("TAKEN", one), "Another pipeline already has that name"},
		{"no steps", pl("Zero"), "Add at least one step"},
		{"too many steps", pl("Many", many...), "At most 30 steps"},
		{"options too big", pl("Big", big), "The steps' options are too big (1 MiB at most)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			check := e.r.Describe(c.p)
			if !slices.Contains(check.Problems, c.want) || check.Ready {
				t.Fatalf("problems = %q ready=%v", check.Problems, check.Ready)
			}
		})
	}
	// The saved pipeline itself isn't a duplicate of its own name.
	saved, _ := e.r.Get(e.r.List()[0].Pipeline.ID)
	if c := e.r.Describe(saved); !c.Ready {
		t.Fatalf("saved pipeline not ready: %+v", c.Problems)
	}
}

func TestDescribeWatchFolderRules(t *testing.T) {
	e := describeEnv(t)
	support := t.TempDir()
	e.r.cfg.ProtectedDirs = []string{support}
	folder := t.TempDir()
	file := filepath.Join(folder, "f.txt")
	must(t, os.WriteFile(file, nil, 0o644))
	lib := e.lib
	must(t, os.MkdirAll(filepath.Join(lib, "inner"), 0o755))
	cases := []struct {
		name   string
		folder string
		want   string
	}{
		{"empty", "", "Pick a folder to watch"},
		{"relative", "watch/me", "The watch folder must be a full path"},
		{"missing", filepath.Join(folder, "nope"), "The watch folder doesn't exist"},
		{"a file", file, "The watch folder isn't a folder"},
		{"the library", lib, "The watch folder can't be the Library folder or inside it"},
		{"inside the library", filepath.Join(lib, "inner"), "The watch folder can't be the Library folder or inside it"},
		{"inside support", support, "The watch folder can't be inside Toolbox's own folders"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := pl("W", step("aaaaaaa1", "a", FromInput, fakeOpts{}))
			p.Watch = core.WatchConfig{Enabled: true, Folder: c.folder}
			check := e.r.Describe(p)
			if !slices.Contains(check.Problems, c.want) || check.Ready {
				t.Fatalf("problems = %q", check.Problems)
			}
			// Disabled: the folder isn't checked.
			p.Watch.Enabled = false
			if !e.r.Describe(p).Ready {
				t.Fatal("a disabled watch blocks")
			}
		})
	}
	p := pl("W", step("aaaaaaa1", "a", FromInput, fakeOpts{}))
	p.Watch = core.WatchConfig{Enabled: true, Folder: folder}
	if !e.r.Describe(p).Ready {
		t.Fatalf("good folder: %v", e.r.Describe(p).Problems)
	}
	p.Steps[0].OptionsJSON = opts(fakeOpts{Secret: true})
	if c := e.r.Describe(p); !slices.Contains(c.Problems, "A watched pipeline can't ask for passwords") {
		t.Fatalf("problems = %q", c.Problems)
	}
}
