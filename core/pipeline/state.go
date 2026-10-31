package pipeline

import (
	"context"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"toolbox/core"
)

// cellRef addresses a cell of a run.
type cellRef struct {
	run        string
	item, step int
}

// cellRT is the loop-only runtime state of one cell.
type cellRT struct {
	gen       int // bumped whenever a prepare is started or invalidated
	cancel    context.CancelFunc
	preparing bool      // a PrepareStep goroutine is in flight
	retryAt   time.Time // condition waits: when to prepare again
}

// stepRT is the resolved type of a run's step.
type stepRT struct {
	typ    core.StepType
	ad     core.Chainable
	info   core.StepInfo
	ok     bool // the step type exists
	check  bool
	manual bool
}

// runState is a run plus everything only the loop knows about it.
type runState struct {
	r         core.PipelineRun
	steps     []stepRT
	secrets   map[string]string // "<stepId>.<key>"; memory only
	cancelled bool
	tIdx      int // first together step, -1 if none
	rt        map[[2]int]*cellRT
	jobCount  int
	manual    int // cells waiting for the user to do a step by hand

	touched    bool
	lastStatus core.RunStatus
	persistDue time.Time
	emitDue    time.Time
	lastEmit   time.Time
}

func (rs *runState) cellRT(item, step int) *cellRT {
	k := [2]int{item, step}
	c := rs.rt[k]
	if c == nil {
		c = &cellRT{}
		rs.rt[k] = c
	}
	return c
}

func (rs *runState) stepIndex(id string) int {
	for i, s := range rs.r.Steps {
		if s.ID == id {
			return i
		}
	}
	return -1
}

// merged reports whether the first together step already made its merged item.
func (rs *runState) merged() bool {
	if rs.tIdx < 0 {
		return false
	}
	id := rs.r.Steps[rs.tIdx].ID
	for _, it := range rs.r.Items {
		if it.Input == "" && it.MergedAt == id {
			return true
		}
	}
	return false
}

func (rs *runState) mergedItem() int {
	if rs.tIdx < 0 {
		return -1
	}
	id := rs.r.Steps[rs.tIdx].ID
	for i, it := range rs.r.Items {
		if it.Input == "" && it.MergedAt == id {
			return i
		}
	}
	return -1
}

func isFinal(s core.CellStatus) bool {
	switch s {
	case core.CellDone, core.CellFailed, core.CellCancelled, core.CellSkipped,
		core.CellBlocked, core.CellMerged, core.CellNone:
		return true
	}
	return false
}

// isGood is a final state that lets the item move on.
func isGood(s core.CellStatus) bool {
	switch s {
	case core.CellDone, core.CellSkipped, core.CellMerged, core.CellNone:
		return true
	}
	return false
}

func isActiveCell(s core.CellStatus) bool {
	return s == core.CellPreparing || s == core.CellRunning
}

func isActiveRun(s core.RunStatus) bool { return s == core.RunRunning || s == core.RunWaiting }

func isURL(s string) bool {
	l := strings.ToLower(s)
	return strings.HasPrefix(l, "http://") || strings.HasPrefix(l, "https://")
}

// inputRunFile describes a run input (a path or a link).
func inputRunFile(in string) core.RunFile {
	if isURL(in) {
		return core.RunFile{Path: in, Name: in, Kind: core.KindOther}
	}
	return core.RunFile{Path: in, Name: filepath.Base(in), Kind: core.KindForPath(in)}
}

func inputLabel(in string) string {
	if isURL(in) {
		return in
	}
	return filepath.Base(in)
}

// itemVarName is the {item} value: the label without extension (links keep
// the whole label).
func itemVarName(label string, link bool) string {
	if link {
		return label
	}
	return strings.TrimSuffix(label, filepath.Ext(label))
}

// pathKey normalises a path for comparison.
func pathKey(p string) string {
	if isURL(p) {
		return p
	}
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		p = strings.ToLower(p)
	}
	return p
}

func samePath(a, b string) bool { return pathKey(a) == pathKey(b) }

// within reports whether child is parent or inside it.
func within(parent, child string) bool {
	if parent == "" || child == "" {
		return false
	}
	rel, err := filepath.Rel(pathKey(parent), pathKey(child))
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

// truncBytes cuts s to at most n bytes on a UTF-8 boundary.
func truncBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// truncRunes cuts s to n runes, adding an ellipsis.
func truncRunes(s string, n int) string {
	if len(s) <= n { // fewer bytes than the limit: fewer runes too
		return s
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i := 0
	for k := range s {
		if i == n {
			return s[:k] + "…"
		}
		i++
	}
	return s
}

func cloneSteps(in []core.PipelineStep) []core.PipelineStep {
	out := make([]core.PipelineStep, len(in))
	for i, s := range in {
		s.Filter.Roles = append([]string{}, s.Filter.Roles...)
		s.Filter.Kinds = append([]core.OutputKind{}, s.Filter.Kinds...)
		s.Filter.Exts = append([]string{}, s.Filter.Exts...)
		out[i] = s
	}
	return out
}

// cloneRun deep-copies a run with non-nil slices and maps. varCap > 0 cuts
// every variable value to that many characters (previews on the wire).
func cloneRun(in core.PipelineRun, varCap int) core.PipelineRun {
	out := in
	out.Steps = cloneSteps(in.Steps)
	out.Inputs = append([]string{}, in.Inputs...)
	out.Items = make([]core.RunItem, len(in.Items))
	for i, it := range in.Items {
		out.Items[i] = cloneItem(it, varCap, 0)
	}
	return out
}

// cloneItem copies an item; varCap cuts values to runes, byteCap to bytes.
func cloneItem(it core.RunItem, varCap, byteCap int) core.RunItem {
	o := it
	o.Merged = append([]int{}, it.Merged...)
	o.Cells = make([]core.RunCell, len(it.Cells))
	for i, c := range it.Cells {
		c.JobIDs = append([]string{}, c.JobIDs...)
		c.Inputs = append([]core.RunFile{}, c.Inputs...)
		c.Files = append([]core.RunFile{}, c.Files...)
		o.Cells[i] = c
	}
	o.Vars = make(map[string]string, len(it.Vars))
	for k, v := range it.Vars {
		if varCap > 0 {
			v = truncRunes(v, varCap)
		}
		if byteCap > 0 {
			v = truncBytes(v, byteCap)
		}
		o.Vars[k] = v
	}
	return o
}

func copyVars(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func cloneFiles(in []core.RunFile) []core.RunFile { return append([]core.RunFile{}, in...) }

// builtinVars are the variables every item starts with (SPEC.md §4.3).
func builtinVars(label string, link bool, n int, pipeline string, created time.Time) map[string]string {
	item := itemVarName(label, link)
	t := created.Local()
	return map[string]string{
		"item":     item,
		"name":     item,
		"n":        itoa(n),
		"date":     t.Format("2006-01-02"),
		"time":     t.Format("15-04"),
		"pipeline": pipeline,
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// itemVarBytes is the size of an item's variables.
func itemVarBytes(vars map[string]string) int {
	n := 0
	for k, v := range vars {
		n += len(k) + len(v)
	}
	return n
}

// fitVars cuts the largest values until the item's variables fit the cap.
func fitVars(vars map[string]string) {
	for {
		total := itemVarBytes(vars)
		if total <= core.MaxItemVarBytes {
			return
		}
		excess := total - core.MaxItemVarBytes
		big, bigLen := "", -1
		for k, v := range vars {
			if len(v) > bigLen {
				big, bigLen = k, len(v)
			}
		}
		if bigLen <= 0 {
			return
		}
		cut := bigLen - excess
		if cut < 0 {
			cut = 0
		}
		vars[big] = truncBytes(vars[big], cut)
	}
}

// hostOf is used in short link labels.
func hostOf(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return u
	}
	return p.Host
}
