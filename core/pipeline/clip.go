package pipeline

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"toolbox/core"
)

// The "When I copy…" trigger (Phase 14). Clipboard History hands every copy
// it recorded to ClipboardCopied. Sensitive copies are never recorded, so
// they never get here; and the trigger fires only while recording is on.

const (
	maxClipPatternRunes = 200
	// clipRunsDir is the folder under Config.TmpDir that holds copied text.
	clipRunsDir = "clipboard-runs"
	clipRunsTTL = 7 * 24 * time.Hour
	// maxClipTextBytes keeps a copied text from becoming a huge input file.
	maxClipTextBytes = 1 << 20
)

var clipKinds = []string{core.ClipTriggerLink, core.ClipTriggerImage, core.ClipTriggerText}

// normalizeClip checks and canonicalises a clipboard trigger (Save).
func normalizeClip(c *core.ClipTrigger) error {
	c.Pattern = strings.TrimSpace(c.Pattern)
	kinds := make([]string, 0, len(c.Kinds))
	for _, k := range c.Kinds {
		k = strings.ToLower(strings.TrimSpace(k))
		if !slices.Contains(clipKinds, k) {
			return fieldErr("clip", fmt.Sprintf("Unknown clipboard kind %q", k))
		}
		if !slices.Contains(kinds, k) {
			kinds = append(kinds, k)
		}
	}
	c.Kinds = kinds
	if utf8.RuneCountInString(c.Pattern) > maxClipPatternRunes {
		return fieldErr("clip", "The pattern is too long (200 characters at most)")
	}
	if c.Pattern != "" {
		if _, err := regexp.Compile(c.Pattern); err != nil {
			return fieldErr("clip", "The pattern isn't a valid regular expression")
		}
	}
	return nil
}

// clipProblems are the Describe problems of a clipboard trigger.
func clipProblems(c core.ClipTrigger, accepts core.Accepts) []string {
	if !c.Enabled {
		return nil
	}
	var out []string
	if len(c.Kinds) == 0 {
		return []string{"Choose what to react to: links, images or text"}
	}
	if slices.Contains(c.Kinds, core.ClipTriggerText) {
		if c.Pattern == "" {
			out = append(out, "Type the pattern the copied text must match")
		} else if _, err := regexp.Compile(c.Pattern); err != nil {
			out = append(out, "The pattern isn't a valid regular expression")
		}
	}
	reads := func(ext string) bool { return accepts.Any || slices.Contains(accepts.Extensions, ext) }
	for _, k := range c.Kinds {
		switch {
		case k == core.ClipTriggerLink && !accepts.URLs:
			out = append(out, "This pipeline's first steps don't read links")
		case k == core.ClipTriggerImage && !reads(".png"):
			out = append(out, "This pipeline's first steps don't read images (PNG)")
		case k == core.ClipTriggerText && !reads(".txt"):
			out = append(out, "This pipeline's first steps don't read text files")
		}
	}
	return out
}

// linkOf returns the link when text is exactly one http(s) link.
func linkOf(text string) (string, bool) {
	t := strings.TrimSpace(text)
	if t == "" || strings.ContainsAny(t, " \t\r\n") || !isURL(t) {
		return "", false
	}
	return t, true
}

// clipMatch says which kind of the trigger a recorded copy matches ("" =
// none): an image, a link (link wins over text), or text matching Pattern.
func clipMatch(c core.ClipTrigger, it core.ClipItem) string {
	if !c.Enabled {
		return ""
	}
	switch it.Kind {
	case core.ClipImage:
		if slices.Contains(c.Kinds, core.ClipTriggerImage) && it.ImagePath != "" {
			return core.ClipTriggerImage
		}
	case core.ClipText:
		if _, ok := linkOf(it.Text); ok && slices.Contains(c.Kinds, core.ClipTriggerLink) {
			return core.ClipTriggerLink
		}
		if !slices.Contains(c.Kinds, core.ClipTriggerText) || c.Pattern == "" {
			return ""
		}
		if re, err := regexp.Compile(c.Pattern); err == nil && re.MatchString(it.Text) {
			return core.ClipTriggerText
		}
	}
	return ""
}

// clipState says whether a pipeline's clipboard trigger is live.
func (r *Runner) clipState(p core.Pipeline, check core.PipelineCheck) core.WatchState {
	if !p.Clip.Enabled {
		return core.WatchState{}
	}
	if !check.Ready {
		for i, sc := range check.Steps {
			if len(sc.Problems) > 0 {
				return core.WatchState{Message: fmt.Sprintf("Fix the problems in step %d", i+1)}
			}
		}
		return core.WatchState{Message: "Fix the problems first"}
	}
	if r.cfg.ClipboardOn == nil || !r.cfg.ClipboardOn() {
		return core.WatchState{Message: "Turn on clipboard recording in Clipboard History"}
	}
	return core.WatchState{Active: true}
}

// ClipboardCopied is called by Clipboard History after it recorded a copy
// (never for sensitive copies, never while recording is off). It starts a run
// of every pipeline whose "When I copy…" trigger matches and never blocks.
func (r *Runner) ClipboardCopied(it core.ClipItem) {
	r.mu.Lock()
	if !r.started || r.stopped {
		r.mu.Unlock()
		return
	}
	r.wg.Add(1)
	r.mu.Unlock()
	go func() {
		defer r.wg.Done()
		r.fireClip(it)
	}()
}

func (r *Runner) fireClip(it core.ClipItem) {
	if r.cfg.ClipboardOn == nil || !r.cfg.ClipboardOn() {
		return
	}
	for _, p := range r.snapshotPipes() {
		kind := clipMatch(p.Clip, it)
		if kind == "" {
			continue
		}
		check := r.Describe(p)
		if !r.clipState(p, check).Active {
			continue
		}
		if r.clipRunActive(p.ID) {
			continue // one clipboard run at a time: a step that copies must not loop
		}
		input, err := r.clipInput(kind, it)
		if err != nil {
			slog.Warn("pipelines: clipboard trigger input", "err", err)
			continue
		}
		if _, err := r.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: []string{input}}, "clipboard"); err != nil {
			slog.Debug("pipelines: clipboard run didn't start", "pipeline", p.Name, "err", err)
		}
	}
}

// clipRunActive reports whether a clipboard-triggered run of the pipeline is
// still going.
func (r *Runner) clipRunActive(pipelineID string) bool {
	runs, err := r.Runs(core.RunFilter{PipelineID: pipelineID, ActiveOnly: true})
	if err != nil {
		return false
	}
	for _, run := range runs {
		if run.Trigger == "clipboard" {
			return true
		}
	}
	return false
}

// clipInput turns a copy into a run input: a link, the saved PNG, or a .txt.
func (r *Runner) clipInput(kind string, it core.ClipItem) (string, error) {
	switch kind {
	case core.ClipTriggerImage:
		if _, err := os.Stat(it.ImagePath); err != nil {
			return "", fmt.Errorf("the copied image is gone: %w", err)
		}
		return it.ImagePath, nil
	case core.ClipTriggerLink:
		l, _ := linkOf(it.Text)
		return l, nil
	}
	return r.clipTextFile(it)
}

// clipTextFile writes copied text to <TmpDir>/clipboard-runs/<id>.txt.
func (r *Runner) clipTextFile(it core.ClipItem) (string, error) {
	if r.cfg.TmpDir == "" {
		return "", fmt.Errorf("no temporary folder for copied text")
	}
	if len(it.Text) > maxClipTextBytes {
		return "", fmt.Errorf("the copied text is too long")
	}
	dir := filepath.Join(r.cfg.TmpDir, clipRunsDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("creating %s: %w", clipRunsDir, err)
	}
	name := it.ID
	if name == "" {
		name = core.NewID()
	}
	path := filepath.Join(dir, fmt.Sprintf("copied text %s.txt", name))
	if err := os.WriteFile(path, []byte(it.Text), 0o600); err != nil {
		return "", fmt.Errorf("writing copied text: %w", err)
	}
	return path, nil
}

// pruneClipRuns deletes copied-text files older than a week (at Start).
func (r *Runner) pruneClipRuns() {
	if r.cfg.TmpDir == "" {
		return
	}
	dir := filepath.Join(r.cfg.TmpDir, clipRunsDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := r.now().Add(-clipRunsTTL)
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
