package viz

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/lyrics"
	"toolbox/core/sidecar"
)

func moodAvailable() (string, string, bool) { return "m.onnx", "tok.json", true }

func TestAnalyzeFullWithStems(t *testing.T) {
	eng := newFakeEngine(t)
	a, song := fakeSong(t, eng, nil)
	a.MoodModel = moodAvailable
	ff := fakeFFmpeg(t)
	rec := &jobRec{}
	job := newJob(t, rec)

	o := AnalyzeOptions{Stems: true, Words: WordsDetect, Mood: true}
	ref, err := a.Analyze(context.Background(), job, song, o)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"stems.separate", "viz.analyze", "transcribe.run", "viz.mood"}
	if !reflect.DeepEqual(eng.calls, want) {
		t.Fatalf("calls = %v, want %v", eng.calls, want)
	}
	// stems.separate: four-fast preset, FLAC, <folder>/stems.
	sp := eng.params["stems.separate"]
	if sp["model"] != "htdemucs.yaml" || sp["outputFormat"] != "flac" || filepath.Base(sp["outputDir"].(string)) != "stems" {
		t.Errorf("stems params = %v", sp)
	}
	// viz.analyze gets the four stems and writes into the folder as s1.
	ap := eng.params["viz.analyze"]
	st := ap["stems"].(map[string]any)
	if len(st) != 4 || ap["name"] != "s1" || ap["path"] != song || ap["outDir"] != filepath.Dir(ref.AudioJSON) {
		t.Errorf("analyze params = %v", ap)
	}
	// transcription runs on the vocals stem.
	if in := eng.params["transcribe.run"]["input"].(string); !strings.HasSuffix(in, "Vocals.flac") {
		t.Errorf("transcribed %s", in)
	}
	if len(*ff) != 1 || !strings.Contains(strings.Join((*ff)[0], " "), "amix=inputs=3:normalize=0") {
		t.Errorf("ffmpeg = %v", *ff)
	}
	if ref.Instrumental == "" || !fileOK(ref.Instrumental) || !fileOK(ref.AudioJSON) || !fileOK(ref.FeaturesPath) || !fileOK(ref.TextJSON) {
		t.Errorf("missing files in %+v", ref)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(ref.AudioJSON), "stems")); !os.IsNotExist(err) {
		t.Error("stems folder not deleted")
	}
	if ref.Key != AnalysisKey(mustKey(t, song), o) || !strings.Contains(filepath.Base(ref.TextJSON), "-m1.json") {
		t.Errorf("key = %s text = %s", ref.Key, ref.TextJSON)
	}
	s := ref.Summary
	if s.DurationMs != 10000 || s.Tempo != 120 || s.Key != "A minor" || !reflect.DeepEqual(s.Sections, []string{"intro", "chorus"}) ||
		!s.HasStems || !s.HasWords || !s.HasMeaning || s.MoodSource != "reader" || s.Language != "en" || s.Lines != 2 || len(s.Warnings) != 0 {
		t.Errorf("summary = %+v", s)
	}
	tf := readText(t, ref.TextJSON)
	if len(tf.Lines) != 2 || tf.Lines[0].Text != "We were burning" || tf.Lines[0].Meaning == nil || tf.Lines[0].Meaning.Emotion != "joy" {
		t.Fatalf("text = %+v", tf)
	}
	var emph []string
	for _, l := range tf.Lines {
		for _, w := range l.Words {
			if w.Emphasis {
				emph = append(emph, w.Text)
			}
		}
	}
	if !reflect.DeepEqual(emph, []string{"bright"}) {
		t.Errorf("emphasised = %v", emph)
	}
	if len(tf.Mood) == 0 || tf.Mood[0].Ms != 0 {
		t.Errorf("mood keyframes = %+v", tf.Mood)
	}
	// progress never goes backwards and ends at 1.
	for i := 1; i < len(rec.progress); i++ {
		if rec.progress[i] < rec.progress[i-1]-1e-9 {
			t.Fatalf("progress went back: %v", rec.progress)
		}
	}
	if last := rec.progress[len(rec.progress)-1]; last != 1 {
		t.Errorf("last progress = %v", last)
	}
	if got, ok := a.Lookup(ref.Key); !ok || got.TextJSON != ref.TextJSON {
		t.Error("ref not stored")
	}

	// A second run is fully cached.
	eng.reset()
	ref2, err := a.Analyze(context.Background(), newJob(t, &jobRec{}), song, o)
	if err != nil || ref2.Key != ref.Key || len(eng.calls) != 0 {
		t.Fatalf("cached run: %v calls=%v", err, eng.calls)
	}
}

func mustKey(t *testing.T, p string) string {
	k, err := FileKey(p)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestAnalyzePerStepReuse(t *testing.T) {
	eng := newFakeEngine(t)
	a, song := fakeSong(t, eng, nil)
	job := newJob(t, &jobRec{})
	// Audio only, no stems, no words.
	ref, err := a.Analyze(context.Background(), job, song, AnalyzeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if ref.TextJSON != "" || ref.Instrumental != "" || !reflect.DeepEqual(eng.calls, []string{"viz.analyze"}) {
		t.Fatalf("ref=%+v calls=%v", ref, eng.calls)
	}
	// Adding words reuses the audio features.
	eng.reset()
	o := AnalyzeOptions{Words: WordsDetect}
	ref2, err := a.Analyze(context.Background(), job, song, o)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(eng.calls, []string{"transcribe.run"}) || ref2.AudioJSON != ref.AudioJSON {
		t.Errorf("calls = %v", eng.calls)
	}
	if in := eng.params["transcribe.run"]["input"]; in != song {
		t.Errorf("without stems the input is transcribed, got %v", in)
	}
	// With the ref gone but the files present, nothing runs again.
	eng.reset()
	_ = os.Remove(filepath.Join(a.cacheDir, mustKey(t, song), ref2.Key+".ref.json"))
	if _, err := a.Analyze(context.Background(), job, song, o); err != nil || len(eng.calls) != 0 {
		t.Fatalf("err=%v calls=%v", err, eng.calls)
	}
	// Mood without the model: a warning, source music.
	o3 := AnalyzeOptions{Words: WordsDetect, Mood: true}
	ref3, err := a.Analyze(context.Background(), job, song, o3)
	if err != nil {
		t.Fatal(err)
	}
	s := ref3.Summary
	if s.MoodSource != "music" || s.HasMeaning || len(s.Warnings) != 1 || s.Warnings[0] != warnNoReader {
		t.Errorf("summary = %+v", s)
	}
	if tf := readText(t, ref3.TextJSON); len(tf.Mood) == 0 || tf.Lines[0].Meaning != nil {
		t.Errorf("text = %+v", tf)
	}
}

func TestAnalyzeWordsSources(t *testing.T) {
	dir := t.TempDir()
	lrc := filepath.Join(dir, "l.lrc")
	if err := os.WriteFile(lrc, []byte("[00:01.00]hello there\n[00:04.00]second line\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	txt := filepath.Join(dir, "l.txt")
	if err := os.WriteFile(txt, []byte("We were burning\nbright tonight\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name      string
		o         AnalyzeOptions
		wantCalls []string
		lines     int
		matchedLo float64
		warn      string
	}{
		{"given", AnalyzeOptions{Words: WordsGiven, Lines: []lyrics.Line{{StartMs: 1000, EndMs: 3000, Text: "one two"}}}, []string{"viz.analyze"}, 1, 1, ""},
		{"file lrc", AnalyzeOptions{Words: WordsFile, LyricsPath: lrc}, []string{"viz.analyze"}, 2, 1, ""},
		{"file txt aligns", AnalyzeOptions{Words: WordsFile, LyricsPath: txt}, []string{"viz.analyze", "transcribe.run"}, 2, 0.9, ""},
		{"align", AnalyzeOptions{Words: WordsAlign, LyricsText: "We were burning\nbright tonight"}, []string{"viz.analyze", "transcribe.run"}, 2, 0.9, ""},
		{"align badly", AnalyzeOptions{Words: WordsAlign, LyricsText: "zzzz qqqq xxxx yyyy wwww vvvv"}, []string{"viz.analyze", "transcribe.run"}, 1, 0, warnWeakAlignment},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			eng := newFakeEngine(t)
			a, song := fakeSong(t, eng, nil)
			ref, err := a.Analyze(context.Background(), newJob(t, &jobRec{}), song, tc.o)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(eng.calls, tc.wantCalls) {
				t.Errorf("calls = %v", eng.calls)
			}
			tf := readText(t, ref.TextJSON)
			if len(tf.Lines) != tc.lines || tf.Matched < tc.matchedLo {
				t.Errorf("lines=%d matched=%v", len(tf.Lines), tf.Matched)
			}
			for _, l := range tf.Lines {
				if len(l.Words) == 0 {
					t.Errorf("line %q has no words", l.Text)
				}
			}
			if tc.warn != "" && !contains(ref.Summary.Warnings, tc.warn) {
				t.Errorf("warnings = %v", ref.Summary.Warnings)
			}
			if tc.warn == "" && len(ref.Summary.Warnings) != 0 {
				t.Errorf("warnings = %v", ref.Summary.Warnings)
			}
		})
	}
}

func TestAnalyzeValidation(t *testing.T) {
	eng := newFakeEngine(t)
	a, song := fakeSong(t, eng, nil)
	for name, o := range map[string]AnalyzeOptions{
		"align without text": {Words: WordsAlign},
		"file without path":  {Words: WordsFile},
		"given without":      {Words: WordsGiven},
		"unknown":            {Words: "nope"},
	} {
		_, err := a.Analyze(context.Background(), newJob(t, &jobRec{}), song, o)
		var ae *core.AppError
		if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := a.Analyze(context.Background(), newJob(t, &jobRec{}), filepath.Join(t.TempDir(), "gone.mp3"), AnalyzeOptions{}); err == nil {
		t.Error("missing input accepted")
	}
	if len(eng.calls) != 0 {
		t.Errorf("engine called: %v", eng.calls)
	}
}

func TestAnalyzeEngineMissing(t *testing.T) {
	eng := newFakeEngine(t)
	a, song := fakeSong(t, eng, nil)
	rec := &jobRec{tools: map[string]string{}}
	_, err := a.Analyze(context.Background(), newJob(t, rec), song, AnalyzeOptions{})
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("err = %v", err)
	}
}

func TestAnalyzeFailureRemovesPartials(t *testing.T) {
	eng := newFakeEngine(t)
	a, song := fakeSong(t, eng, nil)
	eng.handlers["viz.analyze"] = func(_ context.Context, p map[string]any, _ func(sidecar.Event)) (any, error) {
		_ = os.WriteFile(filepath.Join(p["outDir"].(string), "s1.bin"), []byte("half"), 0o644)
		return nil, core.Errorf(core.CodeToolFailed, "boom")
	}
	fakeFFmpeg(t)
	_, err := a.Analyze(context.Background(), newJob(t, &jobRec{}), song, AnalyzeOptions{Stems: true})
	if err == nil {
		t.Fatal("expected an error")
	}
	entries, _ := os.ReadDir(filepath.Join(a.cacheDir, mustKey(t, song)))
	if len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
}

func TestAnalyzeCancelBetweenSteps(t *testing.T) {
	eng := newFakeEngine(t)
	a, song := fakeSong(t, eng, nil)
	fakeFFmpeg(t)
	ctx, cancel := context.WithCancel(context.Background())
	inner := eng.handlers["stems.separate"]
	eng.handlers["stems.separate"] = func(c context.Context, p map[string]any, emit func(sidecar.Event)) (any, error) {
		cancel() // cancelled right after the first step
		return inner(c, p, emit)
	}
	_, err := a.Analyze(ctx, newJob(t, &jobRec{}), song, AnalyzeOptions{Stems: true})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if eng.count("viz.analyze") != 0 {
		t.Error("kept going after cancel")
	}
	entries, _ := os.ReadDir(filepath.Join(a.cacheDir, mustKey(t, song)))
	if len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
}

func TestAnalyzeSaveStems(t *testing.T) {
	eng := newFakeEngine(t)
	a, song := fakeSong(t, eng, nil)
	fakeFFmpeg(t)
	rec := &jobRec{}
	job := newJob(t, rec)
	o := AnalyzeOptions{Stems: true, SaveStems: true}
	if _, err := a.Analyze(context.Background(), job, song, o); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, p := range rec.outputs {
		names = append(names, filepath.Base(p))
		if filepath.Base(filepath.Dir(p)) != "My Song" || filepath.Base(filepath.Dir(filepath.Dir(p))) != "Stems" {
			t.Errorf("stem placed at %s", p)
		}
		if !fileOK(p) {
			t.Errorf("%s missing", p)
		}
	}
	want := []string{"My Song - Vocals.flac", "My Song - Drums.flac", "My Song - Bass.flac", "My Song - Other.flac"}
	if !reflect.DeepEqual(names, want) {
		t.Errorf("outputs = %v", names)
	}
	// Cached analysis, stems deleted: separation runs again, the features are reused.
	eng.reset()
	rec2 := &jobRec{}
	if _, err := a.Analyze(context.Background(), newJob(t, rec2), song, o); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(eng.calls, []string{"stems.separate"}) || len(rec2.outputs) != 4 {
		t.Errorf("calls = %v outputs = %d", eng.calls, len(rec2.outputs))
	}
	// A custom LibraryOutput replaces job.Output.
	var viaHook int
	a.LibraryOutput = func(_ *core.JobContext, _ string) error { viaHook++; return nil }
	rec3 := &jobRec{}
	if _, err := a.Analyze(context.Background(), newJob(t, rec3), song, o); err != nil || viaHook != 4 || len(rec3.outputs) != 0 {
		t.Errorf("err=%v hook=%d outputs=%d", err, viaHook, len(rec3.outputs))
	}
}

func TestAnalyzeDeepReadWithoutReader(t *testing.T) {
	eng := newFakeEngine(t)
	chat := &fakeChat{reply: func(req core.CompletionRequest, _ int) (string, error) {
		return chatJSON(schemaCount(req), 0.5, 0.6, "hope", []string{"stars"}, []string{"Burning"}), nil
	}}
	a, song := fakeSong(t, eng, chat)
	o := AnalyzeOptions{Words: WordsDetect, DeepRead: true}
	ref, err := a.Analyze(context.Background(), newJob(t, &jobRec{}), song, o)
	if err != nil {
		t.Fatal(err)
	}
	if ref.Summary.MoodSource != "chat" || !ref.Summary.HasMeaning || !strings.Contains(filepath.Base(ref.TextJSON), "-m2.json") {
		t.Errorf("summary = %+v", ref.Summary)
	}
	tf := readText(t, ref.TextJSON)
	if tf.Lines[0].Meaning.Emotion != "hope" || !tf.Lines[0].Words[2].Emphasis {
		t.Errorf("line = %+v", tf.Lines[0])
	}
	// Chat not ready: a warning, music mood.
	a2, song2 := fakeSong(t, newFakeEngine(t), &fakeChat{readyErr: core.ErrDependencyMissing("chat", "")})
	ref2, err := a2.Analyze(context.Background(), newJob(t, &jobRec{}), song2, o)
	if err != nil || ref2.Summary.MoodSource != "music" || !contains(ref2.Summary.Warnings, "Local Chat isn't ready") {
		t.Errorf("err=%v summary=%+v", err, ref2.Summary)
	}
}

func TestAnalyzeReaderAndChat(t *testing.T) {
	eng := newFakeEngine(t)
	chat := &fakeChat{reply: func(req core.CompletionRequest, _ int) (string, error) {
		return chatJSON(schemaCount(req), -0.2, 0.2, "sadness", []string{"rain", "fire", "night", "storm"}[:2], nil), nil
	}}
	a, song := fakeSong(t, eng, chat)
	a.MoodModel = moodAvailable
	ref, err := a.Analyze(context.Background(), newJob(t, &jobRec{}), song, AnalyzeOptions{Words: WordsDetect, Mood: true, DeepRead: true})
	if err != nil {
		t.Fatal(err)
	}
	if ref.Summary.MoodSource != "reader+chat" {
		t.Errorf("source = %s", ref.Summary.MoodSource)
	}
	m := readText(t, ref.TextJSON).Lines[0].Meaning
	// Reader confidence 0.8 >= 0.5: averaged, emotion stays, motifs are the union.
	if m.Emotion != "joy" || m.Valence < 0.29 || m.Valence > 0.31 || m.Energy < 0.49 || m.Energy > 0.51 ||
		!reflect.DeepEqual(m.Motifs, []string{"fire", "rain"}) {
		t.Errorf("meaning = %+v", m)
	}
}

func TestAnalyzeReaderFailureIsAWarning(t *testing.T) {
	eng := newFakeEngine(t)
	eng.handlers["viz.mood"] = func(context.Context, map[string]any, func(sidecar.Event)) (any, error) {
		return nil, core.Errorf(core.CodeToolFailed, "model broke")
	}
	a, song := fakeSong(t, eng, nil)
	a.MoodModel = moodAvailable
	ref, err := a.Analyze(context.Background(), newJob(t, &jobRec{}), song, AnalyzeOptions{Words: WordsDetect, Mood: true})
	if err != nil || ref.Summary.MoodSource != "music" || len(ref.Summary.Warnings) != 1 {
		t.Fatalf("err=%v summary=%+v", err, ref.Summary)
	}
}

func TestInstrumentalArgs(t *testing.T) {
	got := instrumentalArgs("d", "b", "o", "out.flac")
	want := []string{"-hide_banner", "-nostdin", "-y", "-i", "d", "-i", "b", "-i", "o", "-filter_complex", "amix=inputs=3:normalize=0", "-c:a", "flac", "out.flac"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("args = %v", got)
	}
}
