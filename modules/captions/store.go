package captions

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// The service's batch operations (SPEC.md §5.3, §4.1 "Past batches").

func (m *Module) readBatch(dir string) (Batch, error) {
	clean, err := m.checkBatchDir(dir)
	if err != nil {
		return Batch{}, err
	}
	m.batchMu.Lock()
	defer m.batchMu.Unlock()
	return readBatchFile(clean)
}

// batches lists <library>/Captions/*/captions.json, newest first.
func (m *Module) batches() ([]BatchInfo, error) {
	root, err := m.captionsRoot()
	if err != nil {
		return nil, err
	}
	out := []BatchInfo{}
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return nil, core.Errorf(core.CodeInternal, "Couldn't read the Captions folder").WithCause(err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		if _, err := os.Stat(filepath.Join(dir, BatchFile)); err != nil {
			continue
		}
		m.batchMu.Lock()
		b, err := readBatchFile(dir)
		m.batchMu.Unlock()
		if err != nil {
			continue
		}
		_, failed := countItems(b.Items)
		info := BatchInfo{Dir: dir, Name: b.Name, Created: b.Created, Count: len(b.Items), Failed: failed}
		if info.Name == "" {
			info.Name = e.Name()
		}
		for _, it := range b.Items {
			if _, err := os.Stat(it.Input); err == nil {
				info.Cover = it.Input
				break
			}
		}
		out = append(out, info)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	return out, nil
}

// saveBatch writes the user's edits. The stored file is the authority for
// everything but the item fields, notes, edited flags and the style
// settings; items still being written keep their stored fields.
func (m *Module) saveBatch(ctx context.Context, in Batch) error {
	dir, err := m.checkBatchDir(in.Dir)
	if err != nil {
		return err
	}
	m.batchMu.Lock()
	defer m.batchMu.Unlock()
	cur, err := readBatchFile(dir)
	if err != nil {
		return err
	}
	if in.Version != BatchVersion {
		return core.ValidationError("This batch was made by a different version of Toolbox", nil)
	}
	if len(in.Items) != len(cur.Items) {
		return core.ValidationError("The files in this batch changed; reopen it", nil)
	}
	for i := range in.Items {
		if in.Items[i].Input != cur.Items[i].Input {
			return core.ValidationError("The files in this batch changed; reopen it", nil)
		}
		if utf8.RuneCountInString(in.Items[i].Note) > MaxNote {
			return core.ValidationError(fmt.Sprintf("Keep each note under %d characters", MaxNote), nil)
		}
	}
	// Style settings.
	so := in.Options
	if !validPreset(so.Preset) || !validTone(so.Tone) || !validLength(so.Length) || !validNamePattern(so.NamePattern) ||
		so.Hashtags < 0 || so.Hashtags > MaxHashtags || utf8.RuneCountInString(so.Context) > MaxContext {
		return core.ValidationError("Check the Caption Writer settings", nil)
	}
	next := cur
	o := &next.Options
	o.Preset, o.Tone, o.Length, o.Language, o.Emoji, o.Hashtags = so.Preset, so.Tone, so.Length, so.Language, so.Emoji, so.Hashtags
	o.NamePattern, o.Kebab, o.UseHints, o.ReadText, o.Context = so.NamePattern, so.Kebab, so.UseHints, so.ReadText, so.Context

	want := effectiveFields(*o)
	next.Items = make([]Item, len(cur.Items))
	for i, old := range cur.Items {
		it := old
		inc := in.Items[i]
		it.Note = inc.Note
		if old.State == ItemDone && inc.State == ItemDone {
			edited := map[Field]bool{}
			for k, v := range old.Edited {
				edited[k] = v
			}
			for k, v := range inc.Edited {
				if v {
					edited[k] = true
				}
			}
			for _, f := range changedFields(old.Fields, inc.Fields) {
				edited[f] = true
			}
			it.Edited = edited
			f := RepairFields(inc.Fields, without(want, FieldName), *o, "", i+1, edited)
			f.Name = safeName(inc.Fields.Name) // a name is already final: only make it safe
			it.Fields = f
		}
		next.Items[i] = it
	}
	if err := writeBatchFile(next); err != nil {
		return err
	}
	m.putText(ctx, next.Items)
	return nil
}

func without(fs []Field, f Field) []Field {
	out := make([]Field, 0, len(fs))
	for _, x := range fs {
		if x != f {
			out = append(out, x)
		}
	}
	return out
}

// safeName keeps a finished name usable as a file name stem.
func safeName(s string) string {
	s = cleanName(s)
	if utf8.RuneCountInString(s) > NameMax {
		s = strings.Trim(string([]rune(s)[:NameMax]), " .")
	}
	return s
}

func sameList(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// changedFields lists the fields whose text differs.
func changedFields(a, b Fields) []Field {
	var out []Field
	if a.Alt != b.Alt {
		out = append(out, FieldAlt)
	}
	if a.Description != b.Description {
		out = append(out, FieldDescription)
	}
	if a.Caption != b.Caption {
		out = append(out, FieldCaption)
	}
	if !sameList(a.Hashtags, b.Hashtags) {
		out = append(out, FieldHashtags)
	}
	if a.Title != b.Title {
		out = append(out, FieldTitle)
	}
	if !sameList(a.Keywords, b.Keywords) {
		out = append(out, FieldKeywords)
	}
	if a.Name != b.Name {
		out = append(out, FieldName)
	}
	return out
}

// exportText writes batch.md, or one .txt per done file, next to
// captions.json.
func (m *Module) exportText(dir, format string) ([]string, error) {
	clean, err := m.checkBatchDir(dir)
	if err != nil {
		return nil, err
	}
	b, err := m.readBatch(clean)
	if err != nil {
		return nil, err
	}
	switch format {
	case "md":
		var sb strings.Builder
		sb.WriteString("# " + b.Name + "\n")
		for _, it := range b.Items {
			if it.State != ItemDone {
				continue
			}
			sb.WriteString("\n## " + filepath.Base(it.Input) + "\n\n")
			sb.WriteString(fieldsText(it.Fields, true))
		}
		stem := cleanName(b.Name)
		if stem == "" {
			stem = "Captions"
		}
		p, err := uniqueIn(clean, stem, ".md")
		if err != nil {
			return nil, core.Errorf(core.CodeInternal, "Couldn't create the file").WithCause(err)
		}
		if err := os.WriteFile(p, []byte(sb.String()), 0o644); err != nil {
			_ = os.Remove(p)
			return nil, core.Errorf(core.CodeInternal, "Couldn't write the file").WithCause(err)
		}
		return []string{p}, nil
	case "txt":
		out := []string{}
		for _, it := range b.Items {
			if it.State != ItemDone {
				continue
			}
			stem := cleanName(core.StemName(it.Input))
			if stem == "" {
				stem = "captions"
			}
			p, err := uniqueIn(clean, stem, ".txt")
			if err != nil {
				return out, core.Errorf(core.CodeInternal, "Couldn't create the file").WithCause(err)
			}
			if err := os.WriteFile(p, []byte(fieldsText(it.Fields, false)), 0o644); err != nil {
				_ = os.Remove(p)
				return out, core.Errorf(core.CodeInternal, "Couldn't write the file").WithCause(err)
			}
			out = append(out, p)
		}
		return out, nil
	}
	return nil, core.ValidationError("Export as md or txt", nil)
}

// fieldsText lays out a file's non-empty fields.
func fieldsText(f Fields, markdown bool) string {
	var sb strings.Builder
	add := func(label, v string) {
		if strings.TrimSpace(v) == "" {
			return
		}
		if markdown {
			sb.WriteString("**" + label + ":** " + v + "\n\n")
		} else {
			sb.WriteString(label + "\n" + v + "\n\n")
		}
	}
	add("Caption", f.Caption)
	add("Hashtags", strings.Join(f.Hashtags, " "))
	add("Alt text", f.Alt)
	add("Title", f.Title)
	add("Description", f.Description)
	add("Keywords", strings.Join(f.Keywords, ", "))
	add("File name", f.Name)
	return strings.TrimRight(sb.String(), "\n") + "\n"
}

// deleteBatch moves a batch folder to the OS trash.
func (m *Module) deleteBatch(dir string) error {
	clean, err := m.checkBatchDir(dir)
	if err != nil {
		return err
	}
	if m.trasher == nil || !m.trasher.Available() {
		return core.Errorf(core.CodeInternal, "Moving files to the Trash isn't available here")
	}
	if errs := m.trasher.Trash([]string{clean}); len(errs) > 0 && errs[0] != nil {
		return core.Errorf(core.CodeInternal, "Couldn't move the batch to the Trash").WithCause(errs[0])
	}
	return nil
}
