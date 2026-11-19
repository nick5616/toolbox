package viz

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

// PlanForWorker is the JSON the render worker fetches (mirrors
// frontend/src/viz/types.ts PlanForWorker). Paths are /media URLs.
type PlanForWorker struct {
	Analysis workerAnalysis `json:"analysis"`
	ShowJSON string         `json:"showJson"`
	Width    int            `json:"width"`
	Height   int            `json:"height"`
	FPS      int            `json:"fps"`
	StartMs  int64          `json:"startMs"`
	EndMs    int64          `json:"endMs"`
	Mode     RenderMode     `json:"mode"`
	CoverURL string         `json:"coverUrl"`
	ImageURL string         `json:"imageUrl"`
	Seed     int64          `json:"seed"`
	Kind     string         `json:"kind"` // "show" | "edit"
	Edit     *workerEdit    `json:"edit,omitempty"`

	Composition *CompositionPlan `json:"composition,omitempty"`
	Recipe      *RecipePlan      `json:"recipe,omitempty"`
	Still       *StillPlan       `json:"still,omitempty"` // Phase 21: with Edit (Kind "edit")
	Grade       *GradePlan       `json:"grade,omitempty"`
}

type workerEdit struct {
	ProjectJSON string                      `json:"projectJson"`
	Streams     map[string]workerEditStream `json:"streams"`
	Images      map[string]string           `json:"images"`
}

type workerEditStream struct {
	URL      string `json:"url"`
	IndexURL string `json:"indexUrl"`
}

type workerAnalysis struct {
	AudioJSONURL string `json:"audioJsonUrl"`
	FeaturesURL  string `json:"featuresUrl"`
	TextJSONURL  string `json:"textJsonUrl"`
}

// planFileName is the plan's name inside the job's TempDir.
const planFileName = "render-plan.json"

// buildWorkerPlan turns paths into URLs with urlFor ("" stays "").
func buildWorkerPlan(plan RenderPlan, urlFor func(string) (string, error)) (PlanForWorker, error) {
	conv := func(p string) (string, error) {
		if p == "" {
			return "", nil
		}
		return urlFor(p)
	}
	var (
		w   PlanForWorker
		err error
	)
	w.ShowJSON, w.Width, w.Height, w.FPS = plan.ShowJSON, plan.Width, plan.Height, plan.FPS
	w.StartMs, w.EndMs, w.Mode, w.Seed = plan.StartMs, plan.EndMs, plan.Mode, plan.Seed
	if w.Analysis.AudioJSONURL, err = conv(plan.Analysis.AudioJSON); err != nil {
		return w, fmt.Errorf("audio analysis url: %w", err)
	}
	if w.Analysis.FeaturesURL, err = conv(plan.Analysis.FeaturesPath); err != nil {
		return w, fmt.Errorf("features url: %w", err)
	}
	if w.Analysis.TextJSONURL, err = conv(plan.Analysis.TextJSON); err != nil {
		return w, fmt.Errorf("text url: %w", err)
	}
	if w.CoverURL, err = conv(plan.CoverPath); err != nil {
		return w, fmt.Errorf("cover url: %w", err)
	}
	if w.ImageURL, err = conv(plan.ImagePath); err != nil {
		return w, fmt.Errorf("image url: %w", err)
	}
	w.Kind = "show"
	switch {
	case plan.Composition != nil:
		w.Kind = "composition"
		c := *plan.Composition
		w.Composition = &c
	case plan.Recipe != nil:
		w.Kind = "recipe"
		r := *plan.Recipe
		if r.Sources == nil {
			r.Sources = []RecipeSource{}
		}
		w.Recipe = &r
	}
	if plan.Edit != nil {
		w.Kind = "edit"
		e := &workerEdit{ProjectJSON: plan.Edit.ProjectJSON, Streams: map[string]workerEditStream{}, Images: map[string]string{}}
		for k, s := range plan.Edit.Streams {
			var ws workerEditStream
			if ws.URL, err = conv(s.Stream); err != nil {
				return w, fmt.Errorf("stream url: %w", err)
			}
			if ws.IndexURL, err = conv(s.Index); err != nil {
				return w, fmt.Errorf("index url: %w", err)
			}
			e.Streams[k] = ws
		}
		for k, p := range plan.Edit.Images {
			if e.Images[k], err = conv(p); err != nil {
				return w, fmt.Errorf("image url: %w", err)
			}
		}
		w.Edit = e
		if plan.Still != nil {
			s := *plan.Still
			w.Still = &s
		}
		if plan.Grade != nil {
			g := *plan.Grade
			w.Grade = &g
		}
	}
	return w, nil
}

// writePlan writes the worker plan into dir and returns its URL.
func writePlan(dir string, plan RenderPlan, urlFor func(string) (string, error)) (string, error) {
	w, err := buildWorkerPlan(plan, urlFor)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(w)
	if err != nil {
		return "", fmt.Errorf("encode plan: %w", err)
	}
	path := filepath.Join(dir, planFileName)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", fmt.Errorf("write plan: %w", err)
	}
	u, err := urlFor(path)
	if err != nil {
		return "", fmt.Errorf("plan url: %w", err)
	}
	return u, nil
}

// plannedFrames mirrors render.worker.ts: round((end-start)/1000*fps), at
// least 1; an unset end means the analysed duration.
func plannedFrames(plan RenderPlan) int {
	if plan.hostKind() != hostStream {
		return 1 // a still or a document
	}
	end := plan.EndMs
	if end <= plan.StartMs {
		end = plan.Analysis.Summary.DurationMs
	}
	n := int(math.Floor(float64(end-plan.StartMs)/1000*float64(plan.FPS) + 0.5))
	if n < 1 {
		n = 1
	}
	return n
}
