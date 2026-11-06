package pipeline

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
)

func sb(option, v string) core.StepBind { return core.StepBind{Option: option, Var: v} }

func lookupFrom(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestApplyBinds(t *testing.T) {
	cases := []struct {
		name    string
		opts    string
		binds   []core.StepBind
		vars    map[string]string
		want    string // JSON compared semantically; "" = unchanged
		wantErr string
	}{
		{"string as is", `{"title":"x"}`, []core.StepBind{sb("/title", "v")}, map[string]string{"v": "Hello"}, `{"title":"Hello"}`, ""},
		{"number float", `{"speed":1.5}`, []core.StepBind{sb("/speed", "v")}, map[string]string{"v": "2.25"}, `{"speed":2.25}`, ""},
		{"integer is rounded", `{"bpm":120}`, []core.StepBind{sb("/bpm", "v")}, map[string]string{"v": "127.6"}, `{"bpm":128}`, ""},
		{"integer rounds down", `{"bpm":120}`, []core.StepBind{sb("/bpm", "v")}, map[string]string{"v": " 127.4 "}, `{"bpm":127}`, ""},
		{"zero valued integer stays integer", `{"make":0}`, []core.StepBind{sb("/make", "v")}, map[string]string{"v": "3"}, `{"make":3}`, ""},
		{"bool yes", `{"on":false}`, []core.StepBind{sb("/on", "v")}, map[string]string{"v": "YES"}, `{"on":true}`, ""},
		{"bool 0", `{"on":true}`, []core.StepBind{sb("/on", "v")}, map[string]string{"v": "0"}, `{"on":false}`, ""},
		{"bool Off", `{"on":true}`, []core.StepBind{sb("/on", "v")}, map[string]string{"v": "Off"}, `{"on":false}`, ""},
		{"nested", `{"show":{"music":"","fps":30}}`, []core.StepBind{sb("/show/music", "v")}, map[string]string{"v": "/a.wav"}, `{"show":{"music":"/a.wav","fps":30}}`, ""},
		{"array index", `{"list":["a","b"]}`, []core.StepBind{sb("/list/1", "v")}, map[string]string{"v": "z"}, `{"list":["a","z"]}`, ""},
		{"escaped slash and tilde", `{"a/b":"x","c~d":"y"}`, []core.StepBind{sb("/a~1b", "v"), sb("/c~0d", "w")}, map[string]string{"v": "1", "w": "2"}, `{"a/b":"1","c~d":"2"}`, ""},
		{"missing var keeps value", `{"title":"x"}`, []core.StepBind{sb("/title", "nope")}, map[string]string{}, "", ""},
		{"empty var keeps value", `{"speed":1.5}`, []core.StepBind{sb("/speed", "v")}, map[string]string{"v": ""}, "", ""},
		{"missing pointer is skipped", `{"title":"x"}`, []core.StepBind{sb("/nope", "v")}, map[string]string{"v": "1"}, "", ""},
		{"index out of range is skipped", `{"list":["a"]}`, []core.StepBind{sb("/list/5", "v")}, map[string]string{"v": "1"}, "", ""},
		{"object target is skipped", `{"show":{"a":1}}`, []core.StepBind{sb("/show", "v")}, map[string]string{"v": "1"}, "", ""},
		{"array target is skipped", `{"list":[1]}`, []core.StepBind{sb("/list", "v")}, map[string]string{"v": "1"}, "", ""},
		{"null target is skipped", `{"x":null}`, []core.StepBind{sb("/x", "v")}, map[string]string{"v": "1"}, "", ""},
		{"not a number", `{"bpm":120}`, []core.StepBind{sb("/bpm", "bpm")}, map[string]string{"bpm": "abc"}, "", `{bpm} isn't a number ("abc")`},
		{"NaN is not a number", `{"bpm":120}`, []core.StepBind{sb("/bpm", "bpm")}, map[string]string{"bpm": "NaN"}, "", `{bpm} isn't a number ("NaN")`},
		{"not a bool", `{"on":true}`, []core.StepBind{sb("/on", "v")}, map[string]string{"v": "maybe"}, "", `{v} isn't on or off ("maybe")`},
		{"large integers keep their digits", `{"id":9007199254740993,"n":1}`, []core.StepBind{sb("/n", "v")}, map[string]string{"v": "2"}, `{"id":9007199254740993,"n":2}`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := applyBinds(json.RawMessage(c.opts), c.binds, lookupFrom(c.vars))
			if c.wantErr != "" {
				if err == nil || err.Error() != c.wantErr {
					t.Fatalf("err = %v, want %q", err, c.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if c.want == "" {
				if string(got) != c.opts {
					t.Fatalf("changed: %s", got)
				}
				return
			}
			var a, b any
			if err := json.Unmarshal(got, &a); err != nil {
				t.Fatalf("invalid result %s", got)
			}
			_ = json.Unmarshal([]byte(c.want), &b)
			ga, _ := json.Marshal(a)
			gb, _ := json.Marshal(b)
			if string(ga) != string(gb) {
				t.Fatalf("got %s, want %s", got, c.want)
			}
			if strings.Contains(c.name, "large") && !strings.Contains(string(got), "9007199254740993") {
				t.Fatalf("lost precision: %s", got)
			}
		})
	}
}

func TestApplyBindsLeavesTheInputAlone(t *testing.T) {
	in := json.RawMessage(`{"title":"x"}`)
	out, err := applyBinds(in, []core.StepBind{sb("/title", "v")}, lookupFrom(map[string]string{"v": "y"}))
	if err != nil || string(in) != `{"title":"x"}` || !strings.Contains(string(out), `"y"`) {
		t.Fatalf("in = %s out = %s err = %v", in, out, err)
	}
}

func choiceParam(name string, choices ...string) core.PipelineParam {
	return core.PipelineParam{Name: name, Label: strings.ToUpper(name), Type: core.ValueChoice, Default: choices[0], Choices: choices}
}

func TestResolveParams(t *testing.T) {
	p := core.Pipeline{Params: []core.PipelineParam{
		{Name: "speed", Label: "Speed", Type: core.ValueNumber, Default: "1.5"},
		{Name: "loud", Label: "Loud", Type: core.ValueToggle, Default: "off"},
		choiceParam("voice", "am_adam", "af_sky"),
		{Name: "tint", Label: "Tint", Type: core.ValueColor, Default: "#ff8c42"},
		{Name: "title", Label: "Title", Type: core.ValueText, Default: ""},
	}}
	got, err := resolveParams(p, map[string]string{"speed": "2", "voice": "af_sky"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"speed": "2", "loud": "off", "voice": "af_sky", "tint": "#ff8c42", "title": ""}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	bad := []struct {
		name, key, val string
	}{
		{"number", "speed", "fast"},
		{"toggle", "loud", "maybe"},
		{"choice", "voice", "bob"},
		{"colour", "tint", "red"},
		{"colour short", "tint", "#fff"},
		{"too long", "title", strings.Repeat("x", 1001)},
		{"unknown key", "nope", "1"},
	}
	for _, b := range bad {
		t.Run(b.name, func(t *testing.T) {
			_, err := resolveParams(p, map[string]string{b.key: b.val})
			if !core.IsCode(err, core.CodeValidation) {
				t.Fatalf("err = %v", err)
			}
			if _, ok := core.AsAppError(err).Fields["params."+b.key]; !ok {
				t.Fatalf("fields = %v", core.AsAppError(err).Fields)
			}
		})
	}
	ok1000 := map[string]string{"title": strings.Repeat("é", 1000)}
	if _, err := resolveParams(p, ok1000); err != nil {
		t.Fatalf("1000 characters should fit: %v", err)
	}
}

func TestParamsAndBindsShape(t *testing.T) {
	good := core.PipelineParam{Name: "speed", Label: "Speed", Type: core.ValueNumber, Default: "1"}
	with := func(f func(*core.PipelineParam)) core.PipelineParam { p := good; f(&p); return p }
	many := make([]core.PipelineParam, 21)
	for i := range many {
		many[i] = good
		many[i].Name = "p" + string(rune('a'+i))
	}
	bad := map[string][]core.PipelineParam{
		"too many":        many,
		"bad name":        {with(func(p *core.PipelineParam) { p.Name = "Speed" })},
		"built-in name":   {with(func(p *core.PipelineParam) { p.Name = "name" })},
		"built-in n":      {with(func(p *core.PipelineParam) { p.Name = "n" })},
		"duplicate":       {good, good},
		"empty label":     {with(func(p *core.PipelineParam) { p.Label = "  " })},
		"long label":      {with(func(p *core.PipelineParam) { p.Label = strings.Repeat("x", 61) })},
		"unknown type":    {with(func(p *core.PipelineParam) { p.Type = "blob" })},
		"file type":       {with(func(p *core.PipelineParam) { p.Type = core.ValueFile; p.Default = "" })},
		"one choice":      {with(func(p *core.PipelineParam) { p.Type, p.Choices, p.Default = core.ValueChoice, []string{"a"}, "a" })},
		"dup choices":     {with(func(p *core.PipelineParam) { p.Type, p.Choices, p.Default = core.ValueChoice, []string{"a", "a"}, "a" })},
		"empty choice":    {with(func(p *core.PipelineParam) { p.Type, p.Choices, p.Default = core.ValueChoice, []string{"a", ""}, "a" })},
		"default not in":  {with(func(p *core.PipelineParam) { p.Type, p.Choices, p.Default = core.ValueChoice, []string{"a", "b"}, "c" })},
		"number default":  {with(func(p *core.PipelineParam) { p.Default = "x" })},
		"colour default":  {with(func(p *core.PipelineParam) { p.Type, p.Default = core.ValueColor, "red" })},
		"toggle default":  {with(func(p *core.PipelineParam) { p.Type, p.Default = core.ValueToggle, "2" })},
		"long default":    {with(func(p *core.PipelineParam) { p.Type, p.Default = core.ValueText, strings.Repeat("x", 1001) })},
		"empty num value": {with(func(p *core.PipelineParam) { p.Default = "" })},
	}
	for name, ps := range bad {
		if paramsProblem(ps) == "" {
			t.Errorf("%s: accepted", name)
		}
	}
	if msg := paramsProblem([]core.PipelineParam{good, choiceParam("voice", "a", "b")}); msg != "" {
		t.Errorf("good params rejected: %s", msg)
	}

	manyBinds := make([]core.StepBind, 51)
	for i := range manyBinds {
		manyBinds[i] = core.StepBind{Option: "/o" + string(rune('a'+i%26)) + string(rune('a'+i/26)), Var: "v"}
	}
	badBinds := map[string][]core.StepBind{
		"too many":     manyBinds,
		"same option":  {sb("/a", "v"), sb("/a", "w")},
		"no slash":     {sb("a", "v")},
		"root":         {sb("/", "v")},
		"empty":        {sb("", "v")},
		"bad var":      {sb("/a", "Bad")},
		"empty var":    {sb("/a", "")},
		"var too long": {sb("/a", strings.Repeat("a", 33))},
	}
	for name, bs := range badBinds {
		if bindsProblem(bs) == "" {
			t.Errorf("%s: accepted", name)
		}
	}
	if bindsProblem([]core.StepBind{sb("/a/b", "v"), sb("/c~1d", "w")}) != "" {
		t.Error("good binds rejected")
	}
	if bindsProblem(manyBinds[:50]) != "" {
		t.Error("50 binds should fit")
	}
}

func TestSaveValidatesBindsAndParams(t *testing.T) {
	e := newEnv(t, 2, &fakeStep{id: "a", split: true})
	e.start()
	mk := func() core.Pipeline {
		return pl("Binds", step("aaaaaaa1", "a", FromInput, fakeOpts{}))
	}
	p := mk()
	p.Steps[0].Binds = []core.StepBind{sb("/make", "n"), sb("/make", "n")}
	if _, err := e.r.Save(p); !core.IsCode(err, core.CodeValidation) || core.AsAppError(err).Fields["steps"] == "" {
		t.Fatalf("duplicate binds: %v", err)
	}
	p = mk()
	p.Params = []core.PipelineParam{{Name: "name", Label: "x", Type: core.ValueText}}
	if _, err := e.r.Save(p); !core.IsCode(err, core.CodeValidation) || core.AsAppError(err).Fields["params"] == "" {
		t.Fatalf("built-in param name: %v", err)
	}
	// Nil lists come back as empty ones, never null.
	ent, err := e.r.Save(mk())
	if err != nil {
		t.Fatal(err)
	}
	if ent.Pipeline.Params == nil || ent.Pipeline.Steps[0].Binds == nil {
		t.Fatalf("nil lists: %+v", ent.Pipeline)
	}
	b, _ := json.Marshal(ent.Pipeline)
	if strings.Contains(string(b), `"binds":null`) || strings.Contains(string(b), `"params":null`) {
		t.Fatalf("null on the wire: %s", b)
	}
	got, _ := e.r.Get(ent.Pipeline.ID)
	if got.Params == nil || got.Steps[0].Binds == nil {
		t.Fatal("Get returned nil lists")
	}
	for _, en := range e.r.List() {
		if en.Pipeline.Params == nil || en.Pipeline.Steps[0].Binds == nil {
			t.Fatal("List returned nil lists")
		}
	}
	// Valid ones are kept.
	p = pl("Binds kept", step("aaaaaaa1", "a", FromInput, fakeOpts{}))
	p.Steps[0].Binds = []core.StepBind{sb("/make", "copies")}
	p.Params = []core.PipelineParam{{Name: "copies", Label: " Copies ", Type: core.ValueNumber, Default: "2"}}
	ent, err = e.r.Save(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(ent.Pipeline.Params) != 1 || ent.Pipeline.Params[0].Label != "Copies" || len(ent.Pipeline.Steps[0].Binds) != 1 {
		t.Fatalf("saved = %+v", ent.Pipeline)
	}
	if ent.Pipeline.Params[0].Choices == nil {
		t.Fatal("choices nil")
	}
}

func TestDescribeBinds(t *testing.T) {
	e := describeEnv(t)
	a := step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"txt": "x"}})
	b := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Make: 1})
	run := func(binds ...core.StepBind) core.PipelineCheck {
		bb := b
		bb.Binds = binds
		p := pl("D", a, bb)
		p.Params = []core.PipelineParam{{Name: "copies", Label: "Copies", Type: core.ValueNumber, Default: "2"}}
		return e.r.Describe(p)
	}

	c := run(core.StepBind{Option: "/make", Var: "copies"})
	if len(c.Steps[1].Problems) != 0 || len(c.Steps[1].Info.Warnings) != 0 {
		t.Fatalf("number into number: %+v %+v", c.Steps[1].Problems, c.Steps[1].Info.Warnings)
	}
	i := slices.IndexFunc(c.Steps[1].Vars, func(v core.StepVar) bool { return v.Name == "copies" })
	if i < 0 || c.Steps[1].Vars[i].Label != "Run parameter · Copies" || c.Steps[1].Vars[i].Type != core.ValueNumber {
		t.Fatalf("param var missing or wrong: %+v", c.Steps[1].Vars)
	}
	if c.Steps[0].Vars[slices.IndexFunc(c.Steps[0].Vars, func(v core.StepVar) bool { return v.Name == "n" })].Type != core.ValueNumber {
		t.Error("{n} should be a number")
	}
	if c.Steps[0].Vars[slices.IndexFunc(c.Steps[0].Vars, func(v core.StepVar) bool { return v.Name == "date" })].Type != core.ValueText {
		t.Error("{date} should be text")
	}

	c = run(core.StepBind{Option: "/make", Var: "txt"})
	if len(c.Steps[1].Problems) != 0 {
		t.Fatalf("text into number is a warning, not a problem: %v", c.Steps[1].Problems)
	}
	if !slices.Contains(c.Steps[1].Info.Warnings, "{txt} is text; the run fails if it isn't a number") {
		t.Fatalf("warnings = %v", c.Steps[1].Info.Warnings)
	}

	c = run(core.StepBind{Option: "/nothing", Var: "copies"})
	if !hasProblem(c, 1, "The nothing setting doesn't exist any more") {
		t.Fatalf("problems = %v", c.Steps[1].Problems)
	}
	c = run(core.StepBind{Option: "/roles", Var: "copies"})
	if len(c.Steps[1].Problems) == 0 {
		t.Fatalf("an array target must be a problem")
	}
	c = run(core.StepBind{Option: "/make", Var: "later"})
	if !hasProblem(c, 1, "{later} isn't made by an earlier step") {
		t.Fatalf("problems = %v", c.Steps[1].Problems)
	}
	if c.Ready {
		t.Fatal("a bind problem must block running")
	}
	// A var made by a step that comes later isn't available either.
	p := pl("D2", step("aaaaaaa1", "a", FromInput, fakeOpts{Make: 1}), step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Vars: map[string]string{"late": "1"}}))
	p.Steps[0].Binds = []core.StepBind{sb("/make", "late")}
	if c := e.r.Describe(p); !hasProblem(c, 0, "{late} isn't made by an earlier step") {
		t.Fatalf("problems = %v", c.Steps[0].Problems)
	}
	// Params are checked by Describe too.
	p = pl("D3", a)
	p.Params = []core.PipelineParam{{Name: "x", Label: "", Type: core.ValueText}}
	if c := e.r.Describe(p); len(c.Problems) == 0 || c.Ready {
		t.Fatalf("a bad param must block: %+v", c.Problems)
	}
}

func cellFiles(r core.PipelineRun, item, step int) int { return len(r.Items[item].Cells[step].Files) }

func TestRunBindsVarIntoLaterStepAndParamIntoOption(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()

	// Step 1 makes {count}=3; step 2 reads it into its number option. A run
	// parameter feeds step 1's own number option.
	s1 := step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"count": "3"}})
	s1.Binds = []core.StepBind{{Option: "/make", Var: "copies"}}
	s2 := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Make: 1})
	s2.Binds = []core.StepBind{{Option: "/make", Var: "count"}}
	p := pl("Binds", s1, s2)
	p.Params = []core.PipelineParam{{Name: "copies", Label: "Copies", Type: core.ValueNumber, Default: "2"}}
	p = e.save(p)

	// The default is used when no value is given.
	run := e.startRun(p, e.files("one.txt")...)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "defaults: step 1 files", cellFiles(done, 0, 0), 2)
	eq(t, "step 2 reads step 1's 2 files, 3 each", cellFiles(done, 0, 1), 6)
	eq(t, "param var kept on the item", done.Items[0].Vars["copies"], "2")

	// A value given at the start wins.
	r2, err := e.r.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: e.files("two.txt"), Params: map[string]string{"copies": "4"}}, "manual")
	must(t, err)
	done = e.waitStatus(r2.ID, core.RunDone)
	eq(t, "given: step 1 files", cellFiles(done, 0, 0), 4)
	eq(t, "given: step 2 files", cellFiles(done, 0, 1), 12)
	eq(t, "param var", done.Items[0].Vars["copies"], "4")

	// A bad value fails the start with the field named.
	_, err = e.r.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: e.files("three.txt"), Params: map[string]string{"copies": "lots"}}, "manual")
	if !core.IsCode(err, core.CodeValidation) || core.AsAppError(err).Fields["params.copies"] == "" {
		t.Fatalf("err = %v", err)
	}
	_, err = e.r.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: e.files("four.txt"), Params: map[string]string{"nope": "1"}}, "manual")
	if !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("unknown key: %v", err)
	}
}

func TestRunBindEmptyKeepsOptionAndBadValueFailsTheCell(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()

	// {blank} is made but empty, so the option keeps its own value (2).
	s0 := step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"blank": ""}})
	s1 := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Make: 2})
	s1.Binds = []core.StepBind{{Option: "/make", Var: "blank"}}
	p := e.save(pl("Empty", s0, s1))
	done := e.waitStatus(e.startRun(p, e.files("one.txt")...).ID, core.RunDone)
	eq(t, "kept own value", cellFiles(done, 0, 1), 2)

	// "abc" can't be a number: the cell fails with a message and a hint.
	t1 := step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"bpm": "abc"}})
	t2 := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Make: 1})
	t2.Label = "Slow down"
	t2.Binds = []core.StepBind{{Option: "/make", Var: "bpm"}}
	p = e.save(pl("Bad", t1, t2))
	failed := e.waitStatus(e.startRun(p, e.files("two.txt")...).ID, core.RunFailed)
	c := failed.Items[0].Cells[1]
	eq(t, "status", c.Status, core.CellFailed)
	eq(t, "message", c.Error, `Slow down: {bpm} isn't a number ("abc")`)
	eq(t, "hint", c.ErrorHint, "Check what step 1 makes")
	eq(t, "code", c.ErrorCode, core.CodeValidation)
}

func TestBindFallsBackToTheFirstInputFile(t *testing.T) {
	e := newEnv(t, 2, &fakeStep{id: "a", split: true})
	e.start()
	// {ext} isn't an item variable, so it comes from the file's own vars.
	s := step("aaaaaaa1", "a", FromInput, fakeOpts{Ext: ".txt"})
	s.Binds = []core.StepBind{{Option: "/ext", Var: "ext"}}
	p := e.save(pl("FileVars", s))
	run := e.startRun(p, e.files("one.wav")...)
	done := e.waitStatus(run.ID, core.RunDone)
	f := done.Items[0].Cells[0].Files
	if len(f) != 1 || f[0].Name != "onewav" { // ext "wav" (no dot) replaced ".txt"
		t.Fatalf("files = %v", fileNames(f))
	}
}
