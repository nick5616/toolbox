package pipeline

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// prod is a resolved product: StepProduct plus "this is a link".
type prod struct {
	core.StepProduct
	url bool
}

var passThrough = []core.StepProduct{{Many: true}}

var builtinVarList = []core.StepVar{
	{Name: "item", Label: "Item name", Type: core.ValueText},
	{Name: "name", Label: "File name", Type: core.ValueText},
	{Name: "ext", Label: "File extension", Type: core.ValueText},
	{Name: "role", Label: "File role", Type: core.ValueText},
	{Name: "n", Label: "Item number", Type: core.ValueNumber},
	{Name: "date", Label: "Run date", Type: core.ValueText},
	{Name: "time", Label: "Run time", Type: core.ValueText},
	{Name: "weekday", Label: "Run weekday", Type: core.ValueText},
	{Name: "pipeline", Label: "Pipeline name", Type: core.ValueText},
}

// Describe checks a pipeline (SPEC.md §8.8).
func (r *Runner) Describe(p core.Pipeline) core.PipelineCheck {
	check := core.PipelineCheck{
		Steps:    make([]core.StepCheck, 0, len(p.Steps)),
		Accepts:  core.Accepts{Extensions: []string{}},
		Problems: []string{},
		Secrets:  []core.SecretAsk{},
		Missing:  []string{},
	}
	n := len(p.Steps)
	allPipes := r.snapshotPipes()
	prods := make([][]prod, n)
	infos := make([]core.StepInfo, n)
	ids := map[string]int{}
	stepProblems := false
	optionsBytes := 0
	for i, s := range p.Steps {
		if _, dup := ids[s.ID]; !dup && s.ID != "" {
			ids[s.ID] = i
		}
	}

	for i, s := range p.Steps {
		optionsBytes += len(s.OptionsJSON)
		sc := core.StepCheck{StepID: s.ID, Problems: []string{}, Vars: []core.StepVar{}}
		t, ad, ok := r.stepType(s.Type)
		isCheck := s.Type == CheckType
		name := "This step's tool"
		if ok {
			name = t.Name
		} else if d, found := r.cfg.Reg.Descriptor(s.Type); found {
			name = d.Name
		}
		var info core.StepInfo
		opts := json.RawMessage(s.OptionsJSON)
		validOpts := true
		if strings.TrimSpace(s.OptionsJSON) == "" {
			opts = json.RawMessage("{}")
		} else if !json.Valid(opts) {
			validOpts = false
			opts = json.RawMessage("{}")
		}
		auto := false
		switch {
		case !ok:
			sc.Problems = append(sc.Problems, name+" isn't available")
		case isCheck:
			info = core.StepInfo{Accepts: core.Accepts{Any: true, Extensions: []string{}}, Produces: passThrough}
		case s.Manual:
			if !t.Manual {
				sc.Problems = append(sc.Problems, name+" can't be done by hand")
			}
			info = core.StepInfo{Accepts: t.Accepts, Produces: passThrough}
		case ad == nil || !t.Auto:
			sc.Problems = append(sc.Problems, name+" can't run on its own: switch on \"I'll do this step myself\"")
			info = core.StepInfo{Accepts: t.Accepts, Produces: passThrough}
		default:
			auto = true
			if !validOpts {
				sc.Problems = append(sc.Problems, "The options aren't valid")
			}
			var err error
			info, err = ad.DescribeStep(opts)
			if err != nil {
				sc.Problems = append(sc.Problems, core.AsAppError(err).Message)
				if len(info.Accepts.Extensions) == 0 && !info.Accepts.URLs && !info.Accepts.Any {
					info.Accepts = t.Accepts
				}
			}
		}
		if info.Accepts.Extensions == nil {
			info.Accepts.Extensions = []string{}
		}
		infos[i] = info

		// Variables this step may use: built-ins + earlier steps'.
		vars := append([]core.StepVar{}, builtinVarList...)
		if r.canonicalType(s.Type) == LocalChatType {
			vars = append(vars, core.StepVar{Name: "file", Label: "Text of the files", Type: core.ValueText})
		}
		for _, pp := range p.Params {
			if core.VarName.MatchString(pp.Name) && !slices.ContainsFunc(vars, func(x core.StepVar) bool { return x.Name == pp.Name }) {
				vars = append(vars, core.StepVar{Name: pp.Name, Label: "Run parameter · " + pp.Label, Type: pp.Type})
			}
		}
		for j := 0; j < i; j++ {
			for _, v := range infos[j].Vars {
				if k := slices.IndexFunc(vars, func(x core.StepVar) bool { return x.Name == v.Name }); k >= 0 {
					vars[k] = v
				} else {
					vars = append(vars, v)
				}
			}
		}
		sc.Vars = vars

		// Source and filter.
		var src []prod
		fromStep := -1
		switch s.From {
		case FromInput:
			src = inputProds(info.Accepts)
		case FromNone:
			if ok && !info.NoFiles {
				sc.Problems = append(sc.Problems, name+" needs files: choose where they come from")
			}
		default:
			j, found := ids[s.From]
			switch {
			case s.From == "":
				sc.Problems = append(sc.Problems, "Choose where this step gets its files")
			case found && j < i:
				fromStep, src = j, prods[j]
			case found:
				sc.Problems = append(sc.Problems, "This step reads from a step that comes after it")
			default:
				sc.Problems = append(sc.Problems, "This step reads from a step that doesn't exist")
			}
		}
		filtered := filterProds(src, s.Filter)
		if fromStep >= 0 && len(s.Filter.Roles) > 0 {
			have := map[string]bool{}
			for _, q := range src {
				have[strings.ToLower(q.Role)] = true
			}
			for _, role := range s.Filter.Roles {
				if !have[strings.ToLower(role)] {
					info.Warnings = append(append([]string{}, info.Warnings...),
						fmt.Sprintf("Step %d doesn't make anything with the role \"%s\"", fromStep+1, role))
				}
			}
		}
		var visible []prod
		for _, q := range filtered {
			if prodAccepted(q, info.Accepts) {
				visible = append(visible, q)
			}
		}
		if ok && fromStep >= 0 {
			switch {
			case len(src) == 0:
				if !info.NoFiles {
					sc.Problems = append(sc.Problems, fmt.Sprintf("%s has nothing to read: step %d makes no files", name, fromStep+1))
				}
			case len(filtered) > 0 && len(visible) == 0:
				sc.Problems = append(sc.Problems, fmt.Sprintf("%s can't read what step %d makes (%s)", name, fromStep+1, describeProds(filtered)))
			}
		}

		// A pipeline can't run itself, directly or through others.
		if s.Type == RunPipelineType && p.ID != "" {
			one := p
			one.Steps = []core.PipelineStep{s}
			if cyc := cycleThrough(one, allPipes); len(cyc) > 0 {
				sc.Problems = append(sc.Problems, "This would run the pipeline again: "+strings.Join(cyc, " → "))
			}
		}

		// {vars} in option strings.
		if auto && validOpts {
			allowed := map[string]bool{}
			for _, v := range sc.Vars {
				allowed[v.Name] = true
			}
			seen := map[string]bool{}
			for _, ptr := range info.Templates {
				// {file} and {files} are per-file values a step fills in itself,
				// accepted only in an argument list (Open in app's /args).
				perFile := ptr == "/args" || strings.HasPrefix(ptr, "/args/")
				for _, str := range pointerStrings(opts, ptr) {
					for _, v := range core.TemplateVars(str) {
						if !allowed[v] && !seen[v] && !(perFile && (v == "file" || v == "files")) {
							seen[v] = true
							sc.Problems = append(sc.Problems, "{"+v+"} isn't made by an earlier step")
						}
					}
				}
			}
		}

		// Wired settings (Phase 16).
		if auto && validOpts && len(s.Binds) > 0 {
			probs, warns := bindDescribe(opts, s.Binds, sc.Vars, humanizePtr)
			sc.Problems = append(sc.Problems, probs...)
			if len(warns) > 0 {
				info.Warnings = append(append([]string{}, info.Warnings...), warns...)
			}
		}

		// Secrets and missing tools.
		if auto {
			for _, sec := range info.Secrets {
				check.Secrets = append(check.Secrets, core.SecretAsk{
					StepID: s.ID, Key: sec.Key, Label: fmt.Sprintf("Step %d · %s", i+1, sec.Label),
				})
			}
		}
		if ok && t.ModuleID != "" && (r.cfg.Known != nil || r.cfg.Tools != nil) {
			if d, found := r.cfg.Reg.Descriptor(t.ModuleID); found {
				for _, dep := range d.Requires {
					if r.depMissing(dep) && !slices.Contains(check.Missing, dep) {
						check.Missing = append(check.Missing, dep)
					}
				}
			}
		}

		// What this step makes, resolved.
		resolved := resolveProducts(info.Produces, visible)
		prods[i] = resolved
		info.Produces = prodsToProducts(resolved)
		if info.Vars == nil {
			info.Vars = []core.StepVar{}
		}
		if info.Secrets == nil {
			info.Secrets = []core.StepSecret{}
		}
		if info.Templates == nil {
			info.Templates = []string{}
		}
		if info.Warnings == nil {
			info.Warnings = []string{}
		}
		sc.Info = info
		if s.From == FromInput && ok {
			check.Accepts = unionAccepts(check.Accepts, info.Accepts)
		}
		if len(sc.Problems) > 0 {
			stepProblems = true
		}
		check.Steps = append(check.Steps, sc)
	}

	// Pipeline-level problems.
	name := strings.TrimSpace(p.Name)
	switch {
	case name == "":
		check.Problems = append(check.Problems, "Give the pipeline a name")
	case utf8.RuneCountInString(name) > 80:
		check.Problems = append(check.Problems, "The name is too long (80 characters at most)")
	default:
		for _, o := range r.snapshotPipes() {
			if o.ID != p.ID && strings.EqualFold(o.Name, name) {
				check.Problems = append(check.Problems, "Another pipeline already has that name")
				break
			}
		}
	}
	if msg := paramsProblem(p.Params); msg != "" {
		check.Problems = append(check.Problems, msg)
	}
	if n == 0 {
		check.Problems = append(check.Problems, "Add at least one step")
	}
	if n > MaxSteps {
		check.Problems = append(check.Problems, fmt.Sprintf("At most %d steps", MaxSteps))
	}
	if optionsBytes > MaxOptionsBytes {
		check.Problems = append(check.Problems, "The steps' options are too big (1 MiB at most)")
	}
	check.TakesFiles = takesFiles(p.Steps)
	if p.Watch.Enabled {
		if !check.TakesFiles {
			check.Problems = append(check.Problems, "This pipeline takes no files, so it can't watch a folder")
		}
		check.Problems = append(check.Problems, r.watchFolderProblems(p.Watch.Folder)...)
		if len(check.Secrets) > 0 {
			check.Problems = append(check.Problems, "A watched pipeline can't ask for passwords")
		}
	}
	if p.Clip.Enabled {
		if !check.TakesFiles {
			check.Problems = append(check.Problems, "This pipeline takes no files, so it can't start from a copy")
		} else {
			check.Problems = append(check.Problems, clipProblems(p.Clip, check.Accepts)...)
		}
		if len(check.Secrets) > 0 {
			check.Problems = append(check.Problems, "A pipeline that runs when you copy can't ask for passwords")
		}
	}
	check.Problems = append(check.Problems, scheduleProblems(p)...)
	check.Ready = len(check.Problems) == 0 && !stepProblems && len(check.Missing) == 0 && n > 0
	return check
}

// takesFiles reports whether some step reads the run's files (From "input").
// A pipeline where none does starts with one item and no inputs (SPEC.md §3.5).
func takesFiles(steps []core.PipelineStep) bool {
	return slices.ContainsFunc(steps, func(s core.PipelineStep) bool { return s.From == FromInput })
}

// watchFolderProblems applies the folder rules of SPEC.md §8.9.
func (r *Runner) watchFolderProblems(folder string) []string {
	switch {
	case strings.TrimSpace(folder) == "":
		return []string{"Pick a folder to watch"}
	case !filepath.IsAbs(folder):
		return []string{"The watch folder must be a full path"}
	}
	var out []string
	if lib := r.cfg.Settings().LibraryDir; lib != "" && within(lib, folder) {
		out = append(out, "The watch folder can't be the Library folder or inside it")
	}
	for _, d := range r.cfg.ProtectedDirs {
		if d != "" && within(d, folder) {
			out = append(out, "The watch folder can't be inside Toolbox's own folders")
			break
		}
	}
	info, err := os.Stat(folder)
	switch {
	case err != nil:
		out = append(out, "The watch folder doesn't exist")
	case !info.IsDir():
		out = append(out, "The watch folder isn't a folder")
	}
	return out
}

// inputProds is "everything the step accepts" for From "input".
func inputProds(a core.Accepts) []prod {
	var out []prod
	var kinds []core.OutputKind
	byKind := map[core.OutputKind][]string{}
	for _, e := range a.Extensions {
		k := core.KindForPath("x" + e)
		if _, ok := byKind[k]; !ok {
			kinds = append(kinds, k)
		}
		byKind[k] = append(byKind[k], e)
	}
	for _, k := range kinds {
		out = append(out, prod{StepProduct: core.StepProduct{Kind: k, Exts: byKind[k], Many: true}})
	}
	if a.Any {
		out = append(out, prod{StepProduct: core.StepProduct{Kind: core.KindOther, Exts: []string{}, Many: true}})
	}
	if a.URLs {
		out = append(out, prod{StepProduct: core.StepProduct{Kind: core.KindOther, Exts: []string{}, Many: true}, url: true})
	}
	return out
}

func prodAccepted(p prod, a core.Accepts) bool {
	if p.url {
		return a.URLs
	}
	if a.Any || len(p.Exts) == 0 {
		return true
	}
	for _, e := range p.Exts {
		if slices.Contains(a.Extensions, strings.ToLower(e)) {
			return true
		}
	}
	return false
}

func filterProds(in []prod, f core.StepFilter) []prod {
	var out []prod
	for _, p := range in {
		if len(f.Roles) > 0 {
			ok := false
			for _, r := range f.Roles {
				if strings.EqualFold(r, p.Role) {
					ok = true
				}
			}
			if !ok {
				continue
			}
		}
		if len(f.Kinds) > 0 && !slices.Contains(f.Kinds, p.Kind) {
			continue
		}
		if len(f.Exts) > 0 && len(p.Exts) > 0 {
			ok := false
			for _, e := range p.Exts {
				if slices.Contains(f.Exts, strings.ToLower(e)) {
					ok = true
				}
			}
			if !ok {
				continue
			}
		}
		out = append(out, p)
	}
	return out
}

// resolveProducts replaces "same as input" (Kind "" / Exts nil) with what the
// step's visible sources make.
func resolveProducts(raw []core.StepProduct, src []prod) []prod {
	var out []prod
	add := func(p prod) {
		for _, o := range out {
			if o.Role == p.Role && o.Kind == p.Kind && slices.Equal(o.Exts, p.Exts) && o.url == p.url {
				return
			}
		}
		out = append(out, p)
	}
	for _, p := range raw {
		if p.Kind == "" && p.Exts == nil && p.Role == "" {
			for _, s := range src {
				if !s.url {
					add(s)
				}
			}
			continue
		}
		q := p
		if q.Kind == "" {
			q.Kind = commonKind(src)
		}
		if q.Exts == nil {
			q.Exts = unionExts(src)
		}
		add(prod{StepProduct: q})
	}
	return out
}

func commonKind(src []prod) core.OutputKind {
	var k core.OutputKind
	for _, s := range src {
		if s.url {
			continue
		}
		if k == "" {
			k = s.Kind
		} else if k != s.Kind {
			return core.KindOther
		}
	}
	if k == "" {
		return core.KindOther
	}
	return k
}

func unionExts(src []prod) []string {
	out := []string{}
	for _, s := range src {
		for _, e := range s.Exts {
			if !slices.Contains(out, e) {
				out = append(out, e)
			}
		}
	}
	return out
}

func prodsToProducts(in []prod) []core.StepProduct {
	out := make([]core.StepProduct, 0, len(in))
	for _, p := range in {
		if p.Exts == nil {
			p.Exts = []string{}
		}
		out = append(out, p.StepProduct)
	}
	return out
}

func describeProds(in []prod) string {
	exts := unionExts(in)
	if len(exts) == 0 {
		var kinds []string
		for _, p := range in {
			k := string(p.Kind)
			if !slices.Contains(kinds, k) {
				kinds = append(kinds, k)
			}
		}
		return strings.Join(kinds, ", ")
	}
	if len(exts) > 4 {
		exts = append(exts[:4:4], "…")
	}
	return strings.Join(exts, ", ")
}

func unionAccepts(a, b core.Accepts) core.Accepts {
	for _, e := range b.Extensions {
		if !slices.Contains(a.Extensions, e) {
			a.Extensions = append(a.Extensions, e)
		}
	}
	a.URLs = a.URLs || b.URLs
	a.Any = a.Any || b.Any
	return a
}

// pointerStrings returns the strings under a JSON pointer in raw. A "*"
// segment matches every array element or object value; if the pointer lands
// on an array or object, every string inside is returned.
func pointerStrings(raw json.RawMessage, ptr string) []string {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	nodes := []any{doc}
	if ptr != "" && ptr != "/" {
		for _, seg := range strings.Split(strings.TrimPrefix(ptr, "/"), "/") {
			seg = strings.ReplaceAll(strings.ReplaceAll(seg, "~1", "/"), "~0", "~")
			var next []any
			for _, n := range nodes {
				switch v := n.(type) {
				case map[string]any:
					if seg == "*" {
						for _, x := range v {
							next = append(next, x)
						}
					} else if x, ok := v[seg]; ok {
						next = append(next, x)
					}
				case []any:
					if seg == "*" {
						next = append(next, v...)
					} else if i, err := strconv.Atoi(seg); err == nil && i >= 0 && i < len(v) {
						next = append(next, v[i])
					}
				}
			}
			nodes = next
		}
	}
	var out []string
	var walk func(any)
	walk = func(n any) {
		switch v := n.(type) {
		case string:
			out = append(out, v)
		case []any:
			for _, x := range v {
				walk(x)
			}
		case map[string]any:
			for _, x := range v {
				walk(x)
			}
		}
	}
	for _, n := range nodes {
		walk(n)
	}
	return out
}

// depMissing reports whether a required dependency is known not to be usable.
// With Config.Known it only reads the cached status (an undetected dependency
// is not missing; the list is re-sent when detection finishes). Without it,
// Tools is asked, which may run a version check.
func (r *Runner) depMissing(dep string) bool {
	if r.cfg.Known != nil {
		st, known := r.cfg.Known(dep)
		return known && st.State != core.DepOK
	}
	_, err := r.cfg.Tools(dep)
	return err != nil
}
