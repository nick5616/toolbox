package editstudio

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"toolbox/core"
)

// Markers and captions files (SPEC.md §5.6, §11.7). WP-ES1 owns the markers
// kinds; the srt kind is writeSRT in srt.go (WP-ES9). Keep the dispatch.

// runText is the text action.
func (m *Module) runText(ctx context.Context, job *core.JobContext, req TextRequest) error {
	job.SetTitle("Saving " + req.Name)
	if req.Kind == TextSRT {
		return m.writeSRT(ctx, job, req)
	}
	return m.writeMarkers(ctx, job, req)
}

// markerCSVHeader is the column order of the CSV (§5.6).
var markerCSVHeader = []string{"lane", "timeline_ms", "song_ms", "end_ms", "strength", "label", "bar", "beat"}

// writeMarkers writes markers CSV or JSON into the Library (job.OutputDir).
func (m *Module) writeMarkers(ctx context.Context, job *core.JobContext, req TextRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var (
		data []byte
		ext  string
		err  error
	)
	switch req.Kind {
	case TextMarkersCSV:
		data, err = markersCSV(req.Markers)
		ext = ".csv"
	case TextMarkersJSON:
		data, err = markersJSON(req.Markers, req.Meta)
		ext = ".json"
	default:
		return core.ValidationError("Unknown file type", map[string]string{"kind": "Unknown file type"})
	}
	if err != nil {
		return fmt.Errorf("building %s: %w", req.Kind, err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
		return fmt.Errorf("creating the output folder: %w", err)
	}
	path := core.UniquePath(job.OutputDir, fileStem(req.Name, "Untitled"), ext)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	if _, err := job.Output(path); err != nil {
		return err
	}
	job.Progress(1, "Saved")
	return nil
}

// markersCSV is RFC 4180 (CRLF line ends, quoted where needed) with a header
// row. A point has an empty end_ms; a marker without a beat has an empty beat.
func markersCSV(rows []MarkerRow) ([]byte, error) {
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	w.UseCRLF = true
	if err := w.Write(markerCSVHeader); err != nil {
		return nil, err
	}
	for _, r := range rows {
		end, beat := "", ""
		if r.EndMs > 0 {
			end = strconv.FormatInt(r.EndMs, 10)
		}
		if r.Beat >= 0 {
			beat = strconv.Itoa(r.Beat)
		}
		rec := []string{
			r.Lane,
			strconv.FormatInt(r.TimelineMs, 10),
			strconv.FormatInt(r.SongMs, 10),
			end,
			strconv.FormatFloat(r.Strength, 'f', 3, 64),
			r.Label,
			strconv.Itoa(r.Bar),
			beat,
		}
		if err := w.Write(rec); err != nil {
			return nil, err
		}
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

// markersJSON is {...meta, "markers": [...]}; meta is a JSON object.
func markersJSON(rows []MarkerRow, meta string) ([]byte, error) {
	doc := map[string]json.RawMessage{}
	if strings.TrimSpace(meta) != "" {
		if err := json.Unmarshal([]byte(meta), &doc); err != nil {
			return nil, fmt.Errorf("reading meta: %w", err)
		}
	}
	if rows == nil {
		rows = []MarkerRow{}
	}
	raw, err := json.Marshal(rows)
	if err != nil {
		return nil, err
	}
	doc["markers"] = raw
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}
