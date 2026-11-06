package posts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/core/media"
)

// Pipeline step adapter (Phase 14): "Make a post". The item's photos and
// clips become a new post (saved as a Post Builder project), which is
// exported with the same code as the tool's Export button.

var _ core.Chainable = (*Module)(nil)

// Step formats.
const (
	StepFormatAuto = "auto" // one video: a reel; anything else: a carousel
)

// StepOptions are what the user edits on a Post Builder step.
type StepOptions struct {
	Format       string `json:"format"`       // StepFormatAuto | "carousel" | "reel" | "story"
	Aspect       string `json:"aspect"`       // carousel: "4:5" | "1:1" | "3:4" | "1.91:1"
	Name         string `json:"name"`         // the post's name, takes {vars}; "" = "{item}"
	Caption      string `json:"caption"`      // takes {vars}
	KeepLocation bool   `json:"keepLocation"` // default false: strip location and metadata
}

// DefaultStepOptions: automatic format, 4:5 carousels, named after the item.
func DefaultStepOptions() StepOptions {
	return StepOptions{Format: StepFormatAuto, Aspect: "4:5", Name: "{item}"}
}

func decodeStep(raw json.RawMessage) (StepOptions, error) {
	o := DefaultStepOptions()
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	return o, nil
}

func checkStep(o StepOptions) error {
	switch o.Format {
	case StepFormatAuto, "carousel", "reel", "story":
	default:
		return core.ValidationError("Choose automatic, carousel, reel or story", map[string]string{"format": "Choose a format"})
	}
	if !slices.Contains(carouselAspects, o.Aspect) {
		return core.ValidationError("Choose 4:5, 1:1, 3:4 or 1.91:1", map[string]string{"aspect": "Choose a shape"})
	}
	if utf8.RuneCountInString(o.Caption) > DefaultLimits().MaxCaptionChars {
		return core.ValidationError("The caption is too long (2,200 characters at most)", map[string]string{"caption": "Too long"})
	}
	return nil
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if err := checkStep(o); err != nil {
		return core.StepInfo{}, err
	}
	summary := map[string]string{StepFormatAuto: "Carousel or reel", "carousel": "Carousel " + o.Aspect, "reel": "Reel", "story": "Story"}[o.Format]
	return core.StepInfo{
		Accepts: m.Descriptor().Accepts,
		Produces: []core.StepProduct{
			{Role: "slide", Label: "Slides", Kind: core.KindOther, Exts: []string{".jpg", ".mp4"}, Many: true},
			{Role: "caption", Label: "Caption", Kind: core.KindDocument, Exts: []string{".txt"}},
		},
		Vars:      []core.StepVar{{Name: "post_folder", Label: "Post folder", Type: core.ValueText}, {Name: "caption", Label: "Post caption", Type: core.ValueText}},
		Secrets:   []core.StepSecret{},
		Templates: []string{"/name", "/caption"},
		Warnings:  []string{},
		Summary:   summary,
	}, nil
}

// stepFormat picks the post format for a set of files and how many posts
// they make: auto is a reel for a lone video and a carousel otherwise.
func stepFormat(o StepOptions, files []core.RunFile) string {
	if o.Format != StepFormatAuto {
		return o.Format
	}
	if len(files) == 1 && isVideo(files[0].Path) {
		return "reel"
	}
	return "carousel"
}

func isVideo(path string) bool {
	return slices.Contains(media.VideoExtensions(), strings.ToLower(filepath.Ext(path)))
}

// PrepareStep implements core.Chainable. A carousel or story takes up to 20
// files, so more files make several posts; a reel is one video, so each video
// makes one (photos are left out).
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if err := checkStep(o); err != nil {
		return nil, err
	}
	files := req.Item.Files
	if len(files) == 0 {
		return nil, core.ValidationError("There are no photos or videos for the post", nil)
	}
	format := stepFormat(o, files)
	var groups [][]string
	if format == "reel" {
		for _, f := range files {
			if isVideo(f.Path) {
				groups = append(groups, []string{f.Path})
			}
		}
		if len(groups) == 0 {
			return nil, core.ValidationError("A reel needs a video", nil).WithHint("Use a carousel for photos")
		}
	} else {
		paths := make([]string, len(files))
		for i, f := range files {
			paths[i] = f.Path
		}
		for chunk := range slices.Chunk(paths, DefaultLimits().MaxSlides) {
			groups = append(groups, slices.Clone(chunk))
		}
	}
	nameTpl := o.Name
	if strings.TrimSpace(nameTpl) == "" {
		nameTpl = "{item}"
	}
	caption, _ := core.ExpandVars(o.Caption, req.Item.Vars, core.FileVars(files[0]))
	jobs := make([]core.StepJob, 0, len(groups))
	for i, g := range groups {
		name, _ := core.ExpandVars(nameTpl, req.Item.Vars, core.FileVars(core.RunFile{Path: g[0]}))
		if len(groups) > 1 {
			name = fmt.Sprintf("%s %d", name, i+1)
		}
		jobs = append(jobs, core.StepJob{Inputs: g, Options: Options{
			Action: ActionMake, Name: strings.TrimSpace(name), Format: format, Aspect: o.Aspect,
			Caption: caption, KeepLocation: o.KeepLocation,
		}})
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable: the numbered slides, the caption,
// and the post folder and caption as variables.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		role, label := "slide", "Slide"
		switch name {
		case "caption.txt":
			role, label = "caption", "Caption"
			text, err := readCaption(out.Path)
			if err != nil {
				return res, err
			}
			res.Vars["caption"] = text
		case "alt-text.txt":
			role, label = "alt", "Alt text"
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: name, Kind: out.Kind, Role: role, RoleLabel: label, OutputID: out.ID})
	}
	if strings.TrimSpace(job.ResultJSON) != "" {
		var r ExportResult
		if err := json.Unmarshal([]byte(job.ResultJSON), &r); err != nil {
			return res, fmt.Errorf("reading the result of job %s: %w", job.ID, err)
		}
		if r.Folder != "" {
			res.Vars["post_folder"] = r.Folder
		}
	}
	return res, nil
}

// readCaption reads a caption file (≤ 1 MiB).
func readCaption(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("reading the caption: %w", err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 1<<20))
	if err != nil {
		return "", fmt.Errorf("reading the caption: %w", err)
	}
	return strings.ToValidUTF8(string(b), ""), nil
}
