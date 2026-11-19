package grade

// Options are a grade job's options (one input per job).
type Options struct {
	Recipe Recipe  `json:"recipe"`
	Wild   float64 `json:"wild"`   // 0..1
	Format string  `json:"format"` // "same" | "jpg" | "png" | "webp" (pictures; videos are always .mp4)
	Beat   Beat    `json:"beat"`
}

// Beat syncs animated ops to music (videos).
type Beat struct {
	On   bool   `json:"on"`
	Song string `json:"song"` // "" = the video's own audio
}

// DefaultOptions are the tool's starting options: the empty "Clean" look at Bold.
func DefaultOptions() Options {
	return Options{Recipe: Recipe{V: RecipeVersion, Name: "Clean", Tier: TierFilm, WildCurve: "linear", Ops: []Op{}}, Wild: 0.5, Format: "same"}
}

// StepOptions are the pipeline step's options (SPEC §E1).
type StepOptions struct {
	Look   string  `json:"look"` // a built-in look id or a saved look id
	Wild   float64 `json:"wild"`
	Seed   uint32  `json:"seed"`
	Vibe   string  `json:"vibe"`   // template; when set the chat model writes the look per item
	Format string  `json:"format"` // as Options.Format
}

// DefaultStepOptions are a new step's options.
func DefaultStepOptions() StepOptions {
	return StepOptions{Look: "teal-orange", Wild: 0.5, Format: "same"}
}
