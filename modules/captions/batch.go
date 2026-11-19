package captions

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
)

// Batch files (SPEC.md §5.3): captions.json is the full record, captions.csv
// a spreadsheet copy. Both are rewritten atomically.

const (
	// BatchFile is the batch record's file name.
	BatchFile = "captions.json"
	// CSVFile is the spreadsheet copy's file name.
	CSVFile = "captions.csv"
	// WithCaptionsDir holds "Write into copies" results.
	WithCaptionsDir = "With captions"
	// RenamedDir holds "Rename copies" results.
	RenamedDir = "Renamed"
)

// captionsRoot is <library>/Captions.
func (m *Module) captionsRoot() (string, error) {
	if m.cfg.LibraryDir == nil {
		return "", core.Errorf(core.CodeInternal, "The library folder isn't known")
	}
	lib := m.cfg.LibraryDir()
	if lib == "" {
		return "", core.Errorf(core.CodeInternal, "The library folder isn't known")
	}
	return filepath.Join(lib, OutputSubdir), nil
}

// checkBatchDir returns dir cleaned when it is a batch folder directly
// inside <library>/Captions that holds a captions.json.
func (m *Module) checkBatchDir(dir string) (string, error) {
	root, err := m.captionsRoot()
	if err != nil {
		return "", err
	}
	if dir == "" {
		return "", core.ValidationError("Choose a batch", nil)
	}
	clean := filepath.Clean(dir)
	rel, err := filepath.Rel(root, clean)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.ContainsRune(rel, filepath.Separator) {
		return "", core.ValidationError("That folder isn't a Caption Writer batch", nil)
	}
	fi, err := os.Lstat(clean)
	if err != nil || !fi.IsDir() {
		return "", core.Errorf(core.CodeNotFound, "This batch doesn't exist any more")
	}
	if fi, err := os.Lstat(filepath.Join(clean, BatchFile)); err != nil || !fi.Mode().IsRegular() {
		return "", core.ValidationError("That folder isn't a Caption Writer batch", nil)
	}
	return clean, nil
}

// readBatchFile reads dir/captions.json; Dir is set from dir, never from
// the file.
func readBatchFile(dir string) (Batch, error) {
	raw, err := os.ReadFile(filepath.Join(dir, BatchFile))
	if err != nil {
		return Batch{}, core.Errorf(core.CodeNotFound, "Couldn't read this batch").WithCause(err)
	}
	var b Batch
	if err := json.Unmarshal(raw, &b); err != nil {
		return Batch{}, core.Errorf(core.CodeValidation, "This batch file is damaged").WithCause(err)
	}
	if b.Version != BatchVersion {
		return Batch{}, core.Errorf(core.CodeValidation, "This batch was made by a different version of Toolbox")
	}
	b.Dir = dir
	normalizeBatch(&b)
	return b, nil
}

func normalizeBatch(b *Batch) {
	if b.Items == nil {
		b.Items = []Item{}
	}
	if b.Options.Notes == nil {
		b.Options.Notes = map[string]string{}
	}
	for i := range b.Items {
		it := &b.Items[i]
		if it.Fields.Hashtags == nil {
			it.Fields.Hashtags = []string{}
		}
		if it.Fields.Keywords == nil {
			it.Fields.Keywords = []string{}
		}
		if it.Edited == nil {
			it.Edited = map[Field]bool{}
		}
	}
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// writeBatchFile writes captions.json and captions.csv into b.Dir.
func writeBatchFile(b Batch) error {
	if b.Dir == "" {
		return errors.New("batch has no folder")
	}
	normalizeBatch(&b)
	dir := b.Dir
	b.Dir = ""
	raw, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return fmt.Errorf("encode batch: %w", err)
	}
	if err := writeFileAtomic(filepath.Join(dir, BatchFile), raw); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the captions").WithCause(err)
	}
	b.Dir = dir
	if err := writeFileAtomic(filepath.Join(dir, CSVFile), batchCSV(b)); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the captions table").WithCause(err)
	}
	return nil
}

// csvCell neutralises spreadsheet formulas.
func csvCell(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

// batchCSV is the table: file, alt, caption, hashtags, title, description,
// keywords, name (UTF-8 with a BOM so spreadsheets read it right).
func batchCSV(b Batch) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0xEF, 0xBB, 0xBF})
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"file", "alt", "caption", "hashtags", "title", "description", "keywords", "name"})
	for _, it := range b.Items {
		f := it.Fields
		_ = w.Write([]string{
			csvCell(filepath.Base(it.Input)), csvCell(f.Alt), csvCell(f.Caption), strings.Join(f.Hashtags, " "),
			csvCell(f.Title), csvCell(f.Description), strings.Join(f.Keywords, ", "), csvCell(f.Name),
		})
	}
	w.Flush()
	return buf.Bytes()
}

// itemText is what Smart search indexes for a captioned file.
func itemText(f Fields) string {
	var parts []string
	for _, s := range []string{f.Title, f.Alt, f.Caption, f.Description, strings.Join(f.Keywords, ", "), strings.Join(f.Hashtags, " ")} {
		if s = strings.TrimSpace(s); s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, "\n")
}

// putText stores the done items' text in Smart search (source "caption").
// Index problems never fail the caller.
func (m *Module) putText(ctx context.Context, items []Item) {
	for _, it := range items {
		if it.State != ItemDone {
			continue
		}
		text := itemText(it.Fields)
		if text == "" {
			continue
		}
		_ = m.cfg.Sink.PutText(ctx, it.Input, core.TextSourceCaption, []core.MediaText{
			{Source: core.TextSourceCaption, Pos: -1, EndPos: -1, Text: text},
		})
	}
}

// updateItem reloads the batch, lets fn change one item, and saves it, so
// edits saved by the user in between are never lost.
func (m *Module) updateItem(dir string, idx int, fn func(it *Item)) (Item, error) {
	m.batchMu.Lock()
	defer m.batchMu.Unlock()
	b, err := readBatchFile(dir)
	if err != nil {
		return Item{}, err
	}
	if idx < 0 || idx >= len(b.Items) {
		return Item{}, core.Errorf(core.CodeValidation, "That file isn't in this batch")
	}
	fn(&b.Items[idx])
	if err := writeBatchFile(b); err != nil {
		return Item{}, err
	}
	return b.Items[idx], nil
}

// batchName is the folder name: the context's first words, else the first
// input's folder name.
func batchName(contextText string, inputs []string) string {
	words := strings.Fields(contextText)
	name := ""
	if len(words) > 0 {
		name = strings.Join(words[:min(len(words), 4)], " ")
	} else if len(inputs) > 0 {
		name = filepath.Base(filepath.Dir(inputs[0]))
	}
	name = strings.TrimRight(cleanName(name), ".,;:!? ")
	if r := []rune(name); len(r) > 40 {
		name = strings.TrimSpace(string(r[:40]))
	}
	if name == "" || name == "." || name == string(filepath.Separator) {
		name = "Captions"
	}
	return name
}

// makeBatchDir creates <outDir>/<name> <date> (unique).
func makeBatchDir(outDir, name, date string) (string, error) {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't create the Captions folder").WithCause(err)
	}
	for range 1000 {
		p := core.UniquePath(outDir, name+" "+date, "")
		if err := os.Mkdir(p, 0o755); err == nil {
			return p, nil
		} else if !errors.Is(err, os.ErrExist) {
			return "", core.Errorf(core.CodeInternal, "Couldn't create the batch folder").WithCause(err)
		}
	}
	return "", core.Errorf(core.CodeInternal, "Couldn't find a free batch folder name")
}
