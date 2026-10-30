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
