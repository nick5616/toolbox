package pipeline

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// Phase 16: step options wired to variables (binds) and run parameters.

const (
	// MaxBindsPerStep and MaxParams are the save limits of SPEC phase-16 §2.1.
	MaxBindsPerStep = 50
	MaxParams       = 20
	maxParamValue   = 1000
)

var colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// ptrSegments splits an RFC 6901 pointer ("/a/b~1c") into unescaped segments.
// "" and "/" are not valid bind targets.
func ptrSegments(ptr string) ([]string, bool) {
	if !strings.HasPrefix(ptr, "/") || ptr == "/" {
		return nil, false
	}
	parts := strings.Split(ptr[1:], "/")
	for i, s := range parts {
		parts[i] = strings.ReplaceAll(strings.ReplaceAll(s, "~1", "/"), "~0", "~")
	}
	return parts, true
}

// decodeDoc decodes options keeping numbers as their written text.
func decodeDoc(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	return doc, nil
}

// lookupPtr finds the value a pointer addresses.
func lookupPtr(doc any, segs []string) (any, bool) {
	cur := doc
	for _, seg := range segs {
		switch v := cur.(type) {
		case map[string]any:
			x, ok := v[seg]
			if !ok {
				return nil, false
			}
			cur = x
		case []any:
			i, err := strconv.Atoi(seg)
			if err != nil || i < 0 || i >= len(v) || strconv.Itoa(i) != seg {
				return nil, false
			}
			cur = v[i]
		default:
			return nil, false
		}
	}
	return cur, true
}

// setPtr replaces the value a pointer addresses (which must exist).
func setPtr(doc any, segs []string, val any) bool {
	parent, ok := lookupPtr(doc, segs[:len(segs)-1])
	if !ok {
		return false
	}
	last := segs[len(segs)-1]
	switch v := parent.(type) {
	case map[string]any:
		if _, ok := v[last]; !ok {
			return false
		}
		v[last] = val
		return true
	case []any:
		i, err := strconv.Atoi(last)
		if err != nil || i < 0 || i >= len(v) || strconv.Itoa(i) != last {
			return false
		}
		v[i] = val
		return true
	}
	return false
}

// scalarKind reports whether v is a settable leaf (string, number, bool).
func scalarKind(v any) (core.ValueType, bool) {
	switch v.(type) {
	case string:
		return core.ValueText, true
	case json.Number:
		return core.ValueNumber, true
	case bool:
		return core.ValueToggle, true
	}
	return "", false
}

// parseNumber parses a variable value as a finite decimal number.
func parseNumber(s string) (float64, bool) {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// parseToggle accepts true/yes/on/1 and false/no/off/0 in any case.
func parseToggle(s string) (on, ok bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "yes", "on", "1":
		return true, true
	case "false", "no", "off", "0":
		return false, true
	}
	return false, false
}

func isIntegerNumber(n json.Number) bool {
	return !strings.ContainsAny(n.String(), ".eE")
}

// convertTo converts a variable's text to the JSON type of cur. ok is false
// when it doesn't fit.
func convertTo(cur any, value string) (out any, ok bool) {
	switch c := cur.(type) {
	case string:
		return value, true
	case json.Number:
		f, ok := parseNumber(value)
		if !ok {
			return nil, false
		}
		if isIntegerNumber(c) {
			return json.Number(strconv.FormatInt(int64(math.Round(f)), 10)), true
		}
		return json.Number(strconv.FormatFloat(f, 'f', -1, 64)), true
	case bool:
		on, ok := parseToggle(value)
		if !ok {
			return nil, false
		}
		return on, true
	}
	return nil, false
}

// bindError describes a value that doesn't fit its option.
type bindError struct {
	varName, value string
	want           string // "a number" | "on or off"
}

func (e *bindError) Error() string {
	return fmt.Sprintf("{%s} isn't %s (%q)", e.varName, e.want, truncRunes(e.value, 40))
}

// applyBinds writes each bound variable's value into a copy of opts. lookup
// returns a variable's value ("" and false when unknown). Binds that don't
// resolve, resolve to an object or array, or whose variable is empty are
// skipped (Describe reports the first two).
func applyBinds(opts json.RawMessage, binds []core.StepBind, lookup func(string) (string, bool)) (json.RawMessage, error) {
	if len(binds) == 0 {
		return opts, nil
	}
	var doc any
	changed := false
	for _, b := range binds {
		v, ok := lookup(b.Var)
		if !ok || v == "" {
			continue
		}
		segs, ok := ptrSegments(b.Option)
		if !ok {
			continue
		}
		if doc == nil {
			d, err := decodeDoc(opts)
			if err != nil {
				return opts, nil // invalid options are Describe's problem
			}
			doc = d
		}
		cur, found := lookupPtr(doc, segs)
		if !found {
			continue
		}
		if _, scalar := scalarKind(cur); !scalar {
			continue
		}
		val, fits := convertTo(cur, v)
		if !fits {
			want := "a number"
			if _, isBool := cur.(bool); isBool {
				want = "on or off"
			}
			return opts, &bindError{varName: b.Var, value: v, want: want}
		}
		if setPtr(doc, segs, val) {
			changed = true
		}
	}
	if !changed {
		return opts, nil
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return opts, fmt.Errorf("encoding bound options: %w", err)
	}
	return out, nil
}

// ---- run parameters ----

// validateParamValue checks v against the parameter's type; "" means fine.
func validateParamValue(p core.PipelineParam, v string) string {
	if utf8.RuneCountInString(v) > maxParamValue {
		return fmt.Sprintf("Too long (%d characters at most)", maxParamValue)
	}
	switch p.Type {
	case core.ValueNumber:
		if _, ok := parseNumber(v); !ok {
			return "Enter a number"
		}
	case core.ValueToggle:
		if _, ok := parseToggle(v); !ok {
			return "Choose on or off"
		}
	case core.ValueChoice:
		if !slices.Contains(p.Choices, v) {
			return "Choose one of the options"
		}
	case core.ValueColor:
		if !colorRe.MatchString(v) {
			return "Enter a colour like #ff8c42"
		}
	case core.ValueText:
	}
	return ""
}

// resolveParams merges given over each parameter's default and validates the
// result. Unknown keys are an error.
func resolveParams(p core.Pipeline, given map[string]string) (map[string]string, error) {
	out := make(map[string]string, len(p.Params))
	known := map[string]bool{}
	for _, pp := range p.Params {
		known[pp.Name] = true
		v, ok := given[pp.Name]
		if !ok {
			v = pp.Default
		}
		if msg := validateParamValue(pp, v); msg != "" {
			return nil, core.ValidationError(fmt.Sprintf("%s: %s", pp.Label, msg), map[string]string{"params." + pp.Name: msg})
		}
		out[pp.Name] = v
	}
	keys := make([]string, 0)
	for k := range given {
		if !known[k] {
			keys = append(keys, k)
		}
	}
	if len(keys) > 0 {
		slices.Sort(keys)
		msg := "This pipeline has no such parameter"
		return nil, core.ValidationError(msg+": "+keys[0], map[string]string{"params." + keys[0]: msg})
	}
	return out, nil
}

// paramShapeProblem checks one parameter's definition ("" = fine). Defaults
// are validated for their type too.
func paramShapeProblem(pp core.PipelineParam) string {
	if !core.VarName.MatchString(pp.Name) {
		return fmt.Sprintf("%q isn't a valid parameter name", pp.Name)
	}
	for _, b := range builtinVarList {
		if b.Name == pp.Name {
			return fmt.Sprintf("{%s} is a built-in variable", pp.Name)
		}
	}
	if n := utf8.RuneCountInString(strings.TrimSpace(pp.Label)); n < 1 || n > 60 {
		return fmt.Sprintf("{%s}: the label must be 1–60 characters", pp.Name)
	}
	switch pp.Type {
	case core.ValueText, core.ValueNumber, core.ValueToggle, core.ValueChoice, core.ValueColor:
	default:
		return fmt.Sprintf("{%s}: unknown type %q", pp.Name, string(pp.Type))
	}
	if pp.Type == core.ValueChoice {
		if n := len(pp.Choices); n < 2 || n > 30 {
			return fmt.Sprintf("{%s}: a choice needs 2–30 options", pp.Name)
		}
		seen := map[string]bool{}
		for _, c := range pp.Choices {
			if strings.TrimSpace(c) == "" || seen[c] {
				return fmt.Sprintf("{%s}: choices must be unique and not empty", pp.Name)
			}
			seen[c] = true
		}
	}
	if msg := validateParamValue(pp, pp.Default); msg != "" {
		return fmt.Sprintf("{%s}: the default is wrong: %s", pp.Name, strings.ToLower(msg[:1])+msg[1:])
	}
	return ""
}

// paramsProblem checks every parameter and the set ("" = fine).
func paramsProblem(ps []core.PipelineParam) string {
	if len(ps) > MaxParams {
		return fmt.Sprintf("At most %d run parameters", MaxParams)
	}
	seen := map[string]bool{}
	for _, pp := range ps {
		if seen[pp.Name] {
			return fmt.Sprintf("Two run parameters are called {%s}", pp.Name)
		}
		seen[pp.Name] = true
		if msg := paramShapeProblem(pp); msg != "" {
			return msg
		}
	}
	return ""
}

// bindsProblem checks the shape of a step's binds ("" = fine).
func bindsProblem(binds []core.StepBind) string {
	if len(binds) > MaxBindsPerStep {
		return fmt.Sprintf("at most %d wired settings", MaxBindsPerStep)
	}
	seen := map[string]bool{}
	for _, b := range binds {
		if _, ok := ptrSegments(b.Option); !ok {
			return fmt.Sprintf("%q isn't a setting address", b.Option)
		}
		if seen[b.Option] {
			return "a setting is wired twice"
		}
		seen[b.Option] = true
		if !core.VarName.MatchString(b.Var) {
			return fmt.Sprintf("%q isn't a variable name", b.Var)
		}
	}
	return ""
}

// bindDescribe checks a step's binds against its options and the variables it
// can use. It returns problems (block running) and warnings.
func bindDescribe(opts json.RawMessage, binds []core.StepBind, vars []core.StepVar, label func(string) string) (problems, warnings []string) {
	if len(binds) == 0 {
		return nil, nil
	}
	doc, err := decodeDoc(opts)
	for _, b := range binds {
		segs, ok := ptrSegments(b.Option)
		if !ok {
			problems = append(problems, "A wired setting has an invalid address")
			continue
		}
		name := label(b.Option)
		var cur any
		found := false
		if err == nil {
			cur, found = lookupPtr(doc, segs)
		}
		if err == nil && !found {
			problems = append(problems, fmt.Sprintf("The %s setting doesn't exist any more", name))
			continue
		}
		scalar := false
		if found {
			_, scalar = scalarKind(cur)
			if !scalar {
				problems = append(problems, fmt.Sprintf("The %s setting can't take a value", name))
			}
		}
		vi := slices.IndexFunc(vars, func(v core.StepVar) bool { return v.Name == b.Var })
		if vi < 0 {
			problems = append(problems, "{"+b.Var+"} isn't made by an earlier step")
			continue
		}
		vt := vars[vi].Type
		if scalar && (vt == "" || vt == core.ValueText) {
			switch cur.(type) {
			case json.Number:
				warnings = append(warnings, "{"+b.Var+"} is text; the run fails if it isn't a number")
			case bool:
				warnings = append(warnings, "{"+b.Var+"} is text; the run fails if it isn't on or off")
			}
		}
	}
	return problems, warnings
}

// humanizePtr turns a pointer's last segment into words: "/show/maxWidth" ->
// "max width".
func humanizePtr(ptr string) string {
	segs, ok := ptrSegments(ptr)
	if !ok {
		return ptr
	}
	key := segs[len(segs)-1]
	var b strings.Builder
	for i, c := range key {
		switch {
		case c == '_' || c == '-':
			b.WriteByte(' ')
		case c >= 'A' && c <= 'Z':
			if i > 0 {
				b.WriteByte(' ')
			}
			b.WriteRune(c + ('a' - 'A'))
		default:
			b.WriteRune(c)
		}
	}
	return b.String()
}
