package captions

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/core/deps"
)

// result is the job's small result (SPEC.md §5.3).
type result struct {
	BatchDir string `json:"batchDir"`
	Done     int    `json:"done"`
	Failed   int    `json:"failed"`
}

func validPreset(p Preset) bool {
	switch p {
	case PresetPosting, PresetAccessible, PresetCatalogue, PresetRename, PresetEverything:
		return true
	}
	return false
}

func validTone(t Tone) bool {
	switch t {
	case TonePlain, ToneWarm, TonePlayful, ToneProfessional, TonePoetic:
		return true
	}
	return false
}

func validLength(l Length) bool {
	return l == LengthShort || l == LengthMedium || l == LengthLong
}

func validNamePattern(p NamePattern) bool {
	return p == NameOnly || p == NameDate || p == NameNumber
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	fields := map[string]string{}
	switch o.Action {
	case ActionCaption, ActionRegenerate, ActionWrite, ActionRename:
	default:
		return core.ValidationError("Unknown action", map[string]string{"action": "Choose caption, regenerate, write or rename"})
	}
	if !validPreset(o.Preset) {
		fields["preset"] = "Choose what to write"
	}
	if !validTone(o.Tone) {
		fields["tone"] = "Choose a tone"
	}
	if !validLength(o.Length) {
		fields["length"] = "Choose a length"
	}
	if !validNamePattern(o.NamePattern) {
		fields["namePattern"] = "Choose a file name pattern"
	}
	if o.Hashtags < 0 || o.Hashtags > MaxHashtags {
		fields["hashtags"] = fmt.Sprintf("Use 0 to %d hashtags", MaxHashtags)
	}
	if utf8.RuneCountInString(o.Context) > MaxContext {
		fields["context"] = fmt.Sprintf("Keep the context under %d characters", MaxContext)
	}
	for _, n := range o.Notes {
		if utf8.RuneCountInString(n) > MaxNote {
			fields["notes"] = fmt.Sprintf("Keep each note under %d characters", MaxNote)
			break
		}
	}
	if o.Then != "" && o.Then != ThenNothing && o.Then != ThenWriteCopies && o.Then != ThenRenameCopies {
		fields["then"] = "Choose what to do after writing"
	}
	if o.Write.CaptionFrom != "" && o.Write.CaptionFrom != FieldCaption && o.Write.CaptionFrom != FieldDescription {
		fields["write"] = "Caption can come from the caption or the description"
	}
	if len(fields) > 0 {
		return core.ValidationError("Check the Caption Writer options", fields)
	}
	if len(inputs) > MaxInputs {
		return core.ValidationError(fmt.Sprintf("Caption up to %d files at a time", MaxInputs), nil)
	}
	switch o.Action {
	case ActionCaption:
		if len(inputs) == 0 {
			return core.ValidationError("Add photos or videos to caption", nil)
		}
		for _, in := range inputs {
			if !isImage(in) && !isVideo(in) {
				return core.ValidationError(filepath.Base(in)+" isn't a photo or video Caption Writer can read", nil)
			}
			fi, err := os.Stat(in)
			if err != nil || fi.IsDir() {
				return core.ValidationError("Couldn't read "+filepath.Base(in), nil)
			}
		}
	default:
		if _, err := m.checkBatchDir(o.Batch); err != nil {
			return err
		}
		if o.Action == ActionRegenerate && o.Index < -1 {
			return core.ValidationError("Choose a file to regenerate", nil)
		}
	}
	return nil
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	switch o.Action {
	case ActionCaption:
		return m.runCaption(ctx, job, o)
	case ActionRegenerate:
		return m.runRegenerate(ctx, job, o)
	case ActionWrite:
		return m.runWrite(ctx, job, o)
	case ActionRename:
		return m.runRename(ctx, job, o)
	}
	return core.ValidationError("Unknown action", nil)
}

// seedFor derives a repeatable seed from a file path.
func seedFor(input string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(input))
	return int64(h.Sum64() & 0x7fffffffffffffff)
}

// nextSeed is a new seed derived from the previous one (splitmix64).
func nextSeed(prev int64) int64 {
	z := uint64(prev) + 0x9e3779b97f4a7c15
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	z ^= z >> 31
	return int64(z&0x7fffffffffffffff) | 1
}

// model picks the vision model: the option wins, else the engine's.
func (m *Module) model(o Options) (string, error) {
	if o.Model != "" {
		return o.Model, nil
	}
	return m.visionModel()
}

// fileDate is the file's modification day (yyyy-mm-dd).
func fileDate(path string) string {
	if fi, err := os.Stat(path); err == nil {
		return fi.ModTime().Format("2006-01-02")
	}
	return ""
}

// itemRun carries what generating one item needs.
type itemRun struct {
	o      Options // the batch's settings
	model  string
	fields []Field
}

// maxEngineFailures is how many files in a row may fail on the model itself
// before the whole batch stops.
const maxEngineFailures = 3

// generate fills one item. A nil error means the item is done; an error is
// the reason it failed (engineErr says the model itself failed, not the
// reply).
func (m *Module) generate(ctx context.Context, job *core.JobContext, run itemRun, it Item, idx int) (f Fields, engineErr bool, err error) {
	pics, err := m.preparePictures(ctx, job, it.Input, idx)
	if err != nil {
		return Fields{}, false, err
	}
	in := PromptInput{
		Context: run.o.Context, Note: it.Note, Date: fileDate(it.Input), Frames: len(pics), Fields: run.fields,
	}
	if run.o.UseHints {
		if labels, text, ok := m.cfg.Hints.Hints(ctx, it.Input, HintChars); ok {
			in.Labels, in.Text = labels, text
		}
	}
	req := core.CompletionRequest{
		System: SystemPrompt(run.o, run.fields), Prompt: UserPrompt(in), Images: pics, Model: run.model,
		JSONSchema: Schema(run.fields, run.o.Hashtags), Temperature: 0.4, Seed: it.Seed, MaxTokens: 800,
		Purpose: "Writing captions",
	}
	for attempt := 0; attempt < 2; attempt++ {
		reply, err := m.cfg.Vision.Complete(ctx, req)
		if err != nil {
			return Fields{}, ctx.Err() == nil, err
		}
		if raw, ok := ParseReply(reply, run.fields); ok {
			date := fileDate(it.Input)
			out := RepairFields(raw, run.fields, run.o, date, idx+1, nil)
			return out, false, nil
		}
		req.Prompt = UserPrompt(in) + "\n\n" + RetryNote
	}
	return Fields{}, false, core.Errorf(core.CodeToolFailed, "The model didn't reply in the expected format")
}

func (m *Module) emit(jobID, dir string, idx int, it Item) {
	m.cfg.Emitter.Emit(EventItem, ItemEvent{JobID: jobID, Dir: dir, Index: idx, Item: it})
}

func failReason(err error) string {
	return errText(err)
}

func (m *Module) runCaption(ctx context.Context, job *core.JobContext, o Options) error {
	if _, err := job.Tool(deps.Llama); err != nil && o.Model == "" {
		return err
	}
	if m.cfg.Vision == nil {
		return core.Errorf(core.CodeDependencyMissing, "Install the Caption Writer pack to read pictures")
	}
	model, err := m.model(o)
	if err != nil {
		return err
	}
	if o.Notes == nil {
		o.Notes = map[string]string{}
	}
	now := m.now()
	root, err := m.captionsRoot()
	if err != nil {
		return err
	}
	outDir := job.OutputDir
	if outDir == "" {
		outDir = root
	}
	name := batchName(o.Context, job.Inputs)
	dir, err := makeBatchDir(outDir, name, now.Format("2006-01-02"))
	if err != nil {
		return err
	}
	job.SetTitle("Captions: " + name)

	items := make([]Item, len(job.Inputs))
	for i, in := range job.Inputs {
		seed := o.Seed
		if seed == 0 {
			seed = seedFor(in)
		}
		items[i] = Item{
			Input: in, Note: o.Notes[in], Fields: Fields{Hashtags: []string{}, Keywords: []string{}},
			Edited: map[Field]bool{}, State: ItemPending, Seed: seed,
		}
	}
	stored := o
	stored.Action = ActionCaption
	batch := Batch{
		Version: BatchVersion, Name: filepath.Base(dir), Dir: dir, Created: now.UnixMilli(),
		Model: model, Options: stored, Items: items,
	}
	m.batchMu.Lock()
	err = writeBatchFile(batch)
	m.batchMu.Unlock()
	if err != nil {
		return err
	}

	run := itemRun{o: o, model: model, fields: effectiveFields(o)}
	var runErr error
	streak := 0
	for i := range items {
		if err := ctx.Err(); err != nil {
			runErr = err
			break
		}
		job.Progress(float64(i)/float64(len(items)), fmt.Sprintf("Writing captions · %d of %d", i+1, len(items)))
		f, engineErr, gerr := m.generate(ctx, job, run, items[i], i)
		if gerr != nil && ctx.Err() != nil {
			runErr = ctx.Err()
			break
		}
		fin, uerr := m.updateItem(dir, i, func(it *Item) {
			if gerr != nil {
				it.State, it.Reason = ItemFailed, failReason(gerr)
				return
			}
			it.State, it.Reason, it.Fields = ItemDone, "", f
		})
		if uerr != nil {
			runErr = uerr
			break
		}
		items[i] = fin
		m.emit(job.ID, dir, i, fin)
		if gerr != nil {
			job.Log(core.StreamSystem, fmt.Sprintf("%s: %s", filepath.Base(fin.Input), fin.Reason))
			if engineErr {
				streak++
				if ae := core.AsAppError(gerr); streak >= maxEngineFailures || (ae != nil && ae.Code == core.CodeDependencyMissing) {
					runErr = gerr
					break
				}
			} else {
				streak = 0
			}
		} else {
			streak = 0
		}
	}

	// Re-read so edits made while the batch ran are what we register.
	m.batchMu.Lock()
	final, rerr := readBatchFile(dir)
	m.batchMu.Unlock()
	if rerr != nil {
		final = batch
		final.Items = items
	}
	done, failed := countItems(final.Items)
	m.putText(ctx, final.Items)
	if _, err := job.OutputFrom(filepath.Join(dir, BatchFile), job.Inputs...); err != nil && runErr == nil {
		runErr = err
	}
	if _, err := job.OutputFrom(filepath.Join(dir, CSVFile), job.Inputs...); err != nil && runErr == nil {
		runErr = err
	}
	_ = job.SetResult(result{BatchDir: dir, Done: done, Failed: failed})
	if runErr != nil {
		return runErr
	}

	// A pipeline step can write or rename copies in the same job.
	switch o.Then {
	case ThenWriteCopies:
		res, err := m.writeCopies(ctx, job, final, o.Write)
		if err != nil {
			return err
		}
		if err := finishOutcome(res); err != nil {
			return err
		}
	case ThenRenameCopies:
		res, err := m.renameCopies(ctx, job, final)
		if err != nil {
			return err
		}
		if err := finishOutcome(res); err != nil {
			return err
		}
	}
	job.Progress(1, fmt.Sprintf("%d captioned", done))
	return nil
}

func countItems(items []Item) (done, failed int) {
	for _, it := range items {
		switch it.State {
		case ItemDone:
			done++
		case ItemFailed:
			failed++
		}
	}
	return done, failed
}

func (m *Module) loadBatch(o Options) (Batch, error) {
	dir, err := m.checkBatchDir(o.Batch)
	if err != nil {
		return Batch{}, err
	}
	m.batchMu.Lock()
	defer m.batchMu.Unlock()
	return readBatchFile(dir)
}

func (m *Module) runRegenerate(ctx context.Context, job *core.JobContext, o Options) error {
	if _, err := job.Tool(deps.Llama); err != nil && o.Model == "" {
		return err
	}
	if m.cfg.Vision == nil {
		return core.Errorf(core.CodeDependencyMissing, "Install the Caption Writer pack to read pictures")
	}
	b, err := m.loadBatch(o)
	if err != nil {
		return err
	}
	if o.Index >= len(b.Items) {
		return core.ValidationError("That file isn't in this batch", nil)
	}
	model, err := m.model(Options{Model: o.Model})
	if err != nil {
		return err
	}
	run := itemRun{o: b.Options, model: model, fields: effectiveFields(b.Options)}
	var targets []int
	if o.Index >= 0 {
		targets = []int{o.Index}
	} else {
		for i := range b.Items {
			targets = append(targets, i)
		}
	}
	changed := []Item{}
	var runErr error
	streak := 0
	for n, i := range targets {
		if err := ctx.Err(); err != nil {
			runErr = err
			break
		}
		job.Progress(float64(n)/float64(len(targets)), fmt.Sprintf("Writing captions · %d of %d", n+1, len(targets)))
		cur := b.Items[i]
		seed := o.Seed
		if seed == 0 {
			seed = nextSeed(cur.Seed)
		}
		cur.Seed = seed
		f, engineErr, gerr := m.generate(ctx, job, run, cur, i)
		if gerr != nil && ctx.Err() != nil {
			runErr = ctx.Err()
			break
		}
		fin, uerr := m.updateItem(b.Dir, i, func(it *Item) {
			it.Seed = seed
			if gerr != nil {
				it.State, it.Reason = ItemFailed, failReason(gerr)
				return
			}
			it.State, it.Reason = ItemDone, ""
			merged := f
			if o.KeepEdited {
				merged = keepEdited(it.Fields, f, it.Edited)
			} else {
				it.Edited = map[Field]bool{}
			}
			it.Fields = merged
		})
		if uerr != nil {
			runErr = uerr
			break
		}
		changed = append(changed, fin)
		m.emit(job.ID, b.Dir, i, fin)
		if gerr != nil {
			job.Log(core.StreamSystem, fmt.Sprintf("%s: %s", filepath.Base(fin.Input), fin.Reason))
			if engineErr {
				streak++
				if streak >= maxEngineFailures || len(targets) == 1 {
					runErr = gerr
					break
				}
			} else {
				streak = 0
			}
		} else {
			streak = 0
		}
	}
	m.putText(ctx, changed)
	done, failed := countItems(changed)
	_ = job.SetResult(result{BatchDir: b.Dir, Done: done, Failed: failed})
	return runErr
}

// keepEdited returns fresh with every edited field taken from old.
func keepEdited(old, fresh Fields, edited map[Field]bool) Fields {
	out := fresh
	if edited[FieldAlt] {
		out.Alt = old.Alt
	}
	if edited[FieldDescription] {
		out.Description = old.Description
	}
	if edited[FieldCaption] {
		out.Caption = old.Caption
	}
	if edited[FieldHashtags] {
		out.Hashtags = old.Hashtags
	}
	if edited[FieldTitle] {
		out.Title = old.Title
	}
	if edited[FieldKeywords] {
		out.Keywords = old.Keywords
	}
	if edited[FieldName] {
		out.Name = old.Name
	}
	return out
}

func (m *Module) runWrite(ctx context.Context, job *core.JobContext, o Options) error {
	b, err := m.loadBatch(o)
	if err != nil {
		return err
	}
	if o.Write.CaptionFrom == "" {
		o.Write.CaptionFrom = FieldCaption
	}
	res, err := m.writeCopies(ctx, job, b, o.Write)
	if err != nil {
		return err
	}
	_ = job.SetResult(result{BatchDir: b.Dir, Done: res.Written, Failed: res.Failed})
	if err := finishOutcome(res); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("%d written", res.Written))
	return nil
}

func (m *Module) runRename(ctx context.Context, job *core.JobContext, o Options) error {
	b, err := m.loadBatch(o)
	if err != nil {
		return err
	}
	res, err := m.renameCopies(ctx, job, b)
	if err != nil {
		return err
	}
	_ = job.SetResult(result{BatchDir: b.Dir, Done: res.Written, Failed: res.Failed})
	if err := finishOutcome(res); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("%d copied", res.Written))
	return nil
}
