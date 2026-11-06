package scenes

// Output is what the Scene Splitter writes for each scene.
type Output string

const (
	OutputClips  Output = "clips"  // one video clip per scene
	OutputStills Output = "stills" // one JPG per scene (a frame from its middle)
	OutputBoth   Output = "both"
)

// Keep says which scenes are kept.
type Keep string

const (
	KeepAll     Keep = "all"
	KeepLongest Keep = "longest" // the N longest scenes
	KeepActive  Keep = "active"  // the N scenes with the most motion
)

// Limits.
const (
	MinThreshold  = 0.05
	MaxThreshold  = 0.9
	MinSceneSecs  = 0.2
	MaxSceneSecs  = 60.0
	MaxKeepN      = 200
	DefaultThresh = 0.3
	// maxScenes is the most scenes one file may yield after merging; more
	// than this means the threshold is too low.
	maxScenes = 500
)

// Options are the Scene Splitter's per-submission options.
type Options struct {
	Threshold    float64 `json:"threshold"`    // 0.05–0.9: how big a change counts as a cut
	MinSceneSecs float64 `json:"minSceneSecs"` // 0.2–60: shorter scenes merge into their neighbour
	Output       Output  `json:"output"`
	Keep         Keep    `json:"keep"`
	KeepN        int     `json:"keepN"` // 1–200, used when Keep isn't "all"
}

// DefaultOptions: a cut at 0.3, scenes of at least 1 s, clips and stills, all scenes.
func DefaultOptions() Options {
	return Options{Threshold: DefaultThresh, MinSceneSecs: 1, Output: OutputBoth, Keep: KeepAll, KeepN: 10}
}

// Scene is one detected scene (times in source ms).
type Scene struct {
	N       int     `json:"n"` // 1-based position among all detected scenes
	StartMs int64   `json:"startMs"`
	EndMs   int64   `json:"endMs"`
	Motion  float64 `json:"motion"` // mean frame-to-frame change, 0..1
	Clip    string  `json:"clip"`   // output path, "" if not written
	Still   string  `json:"still"`  // output path, "" if not written
}

// Result is a finished job's result: the kept scenes.
type Result struct {
	DurationMs int64    `json:"durationMs"`
	Found      int      `json:"found"` // scenes detected before Keep was applied
	Scenes     []Scene  `json:"scenes"`
	Outputs    []string `json:"outputs"`
	// Reencoded counts clips that couldn't be stream-copied.
	Reencoded int `json:"reencoded"`
}
