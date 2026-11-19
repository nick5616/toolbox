package mediaindex

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/doctext"
	"toolbox/core/media"
	ix "toolbox/core/mediaindex"
	"toolbox/core/sidecar"
)

func cue(startMs, endMs int64, text string) doctext.Chunk {
	return doctext.Chunk{Pos: startMs, EndPos: endMs, Text: text}
}

func TestMergeCues(t *testing.T) {
	// 40 cues of 2 s each: chunks stop at 30 s.
	var cues []doctext.Chunk
	for i := 0; i < 40; i++ {
		cues = append(cues, cue(int64(i)*2000, int64(i)*2000+2000, fmt.Sprintf("line %d", i)))
	}
	got := mergeCues(cues, core.TextSourceSpeech)
	if len(got) != 3 {
		t.Fatalf("got %d chunks: %+v", len(got), got)
	}
	for _, c := range got {
		if c.Source != core.TextSourceSpeech || c.EndPos-c.Pos > speechChunkMs {
			t.Errorf("chunk %+v longer than 30 s", c)
		}
	}
	if got[0].Pos != 0 || got[0].EndPos != 30_000 || got[1].Pos != 30_000 || !strings.HasPrefix(got[0].Text, "line 0 line 1") {
		t.Errorf("chunks = %+v", got)
	}

	// By characters: 20 cues of 100 chars within 10 s → ≤ 1000 chars per chunk.
	cues = cues[:0]
	for i := 0; i < 20; i++ {
		cues = append(cues, cue(int64(i)*500, int64(i)*500+500, strings.Repeat("x", 100)))
	}
	for _, c := range mergeCues(cues, core.TextSourceSubs) {
		if n := len([]rune(c.Text)); n > speechChunkChars {
			t.Errorf("chunk of %d chars", n)
		}
	}
	// One cue longer than the limit is split, keeping its times.
	long := mergeCues([]doctext.Chunk{cue(5000, 9000, strings.Repeat("word ", 500))}, core.TextSourceSpeech)
	if len(long) < 2 || long[0].Pos != 5000 || long[1].EndPos != 9000 {
		t.Errorf("long cue = %+v", long)
	}
	// Empty and backwards cues.
	if got := mergeCues([]doctext.Chunk{cue(0, 1000, "  "), cue(2000, 1000, "odd")}, "speech"); len(got) != 1 || got[0].EndPos != 2000 {
		t.Errorf("odd cues = %+v", got)
	}
}

func TestSpokenMs(t *testing.T) {
	if got := spokenMs([]doctext.Chunk{cue(0, 1000, "a"), cue(500, 1500, "b"), cue(3000, 4000, "c")}); got != 2500 {
		t.Errorf("spokenMs = %d", got)
	}
}

func speechInput(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "talk.mp4")
	if err := os.WriteFile(p, []byte("media"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func withProbe(t *testing.T, info media.Info) {
	t.Helper()
	old := probeMedia
	t.Cleanup(func() { probeMedia = old })
	probeMedia = func(context.Context, string, string) (media.Info, error) { return info, nil }
}

// transcribeHandler answers transcribe.run like the engine: it writes an srt
// of cues into outputDir.
func transcribeHandler(t *testing.T, srt string, durSec float64) func(map[string]any) (any, error) {
	return func(p map[string]any) (any, error) {
		dir, _ := p["outputDir"].(string)
		base, _ := p["baseName"].(string)
		out := filepath.Join(dir, base+".srt")
		if err := os.WriteFile(out, []byte(srt), 0o644); err != nil {
			return nil, err
		}
		return map[string]any{"language": "en", "durationSec": durSec, "segments": 2, "outputs": []string{out}}, nil
	}
}

const twoCueSRT = "1\n00:00:01,000 --> 00:00:05,000\nHello and welcome\n\n2\n00:00:06,000 --> 00:00:10,000\nto the show\n\n"

func TestSpeechTranscribes(t *testing.T) {
	in := speechInput(t)
	withProbe(t, media.Info{DurationMs: 20_000, Audio: []media.AudioStream{{Index: 1}}})
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"transcribe.run": transcribeHandler(t, twoCueSRT, 20)}}
	w := &fakeWriter{maxMin: 60}
	_, sm := newModules(w, c, nil)
	job := newJob(t, []string{in}, ix.SpeechOptions{}, nil)
	if err := sm.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(w.speech) != 1 {
		t.Fatalf("StoreSpeech called %d times", len(w.speech))
	}
	r := w.speech[0]
	if r.Path != in || r.Size != 5 || r.ModMs == 0 || r.NoSpeech || r.Failed != "" || r.Skipped != "" {
		t.Fatalf("result = %+v", r)
	}
	if len(r.Chunks) != 1 || r.Chunks[0].Source != core.TextSourceSpeech || r.Chunks[0].Pos != 1000 || r.Chunks[0].EndPos != 10_000 ||
		r.Chunks[0].Text != "Hello and welcome to the show" {
		t.Errorf("chunks = %+v", r.Chunks)
	}
	p := c.named("transcribe.run")[0].params
	if p["model"] != "Systran/faster-whisper-small" || p["language"] != nil || p["vad"] != true || p["task"] != "transcribe" ||
		fmt.Sprint(p["formats"]) != "[srt]" || filepath.Base(p["modelDir"].(string)) != "small" ||
		!strings.HasPrefix(p["outputDir"].(string), job.TempDir) || p["input"] != in {
		t.Errorf("transcribe params = %+v", p)
	}
}

func TestSpeechCapAndForce(t *testing.T) {
	in := speechInput(t)
	withProbe(t, media.Info{DurationMs: 2 * 3600 * 1000, Audio: []media.AudioStream{{Index: 1}}})
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"transcribe.run": transcribeHandler(t, twoCueSRT, 7200)}}
	w := &fakeWriter{maxMin: 60}
	_, sm := newModules(w, c, nil)
	if err := sm.Run(context.Background(), newJob(t, []string{in}, ix.SpeechOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	if r := w.speech[0]; r.Skipped != "Longer than 60 min" || len(r.Chunks) != 0 || r.NoSpeech {
		t.Errorf("over the cap = %+v", r)
	}
	if len(c.calls) != 0 {
		t.Error("the engine must not run for a skipped file")
	}

	// Force ignores the cap. The two cues cover far less than 5% of two hours.
	w2 := &fakeWriter{maxMin: 60}
	_, sm2 := newModules(w2, c, nil)
	if err := sm2.Run(context.Background(), newJob(t, []string{in}, ix.SpeechOptions{Force: true}, nil)); err != nil {
		t.Fatal(err)
	}
	if len(c.named("transcribe.run")) != 1 || !w2.speech[0].NoSpeech || w2.speech[0].Skipped != "" {
		t.Errorf("forced = %+v", w2.speech[0])
	}

	// Force with a transcript that covers the file keeps the text.
	var sb strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&sb, "%d\n%s --> %s\nwords number %d\n\n", i+1, srtTime(int64(i)*60_000), srtTime(int64(i)*60_000+50_000), i)
	}
	c3 := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"transcribe.run": transcribeHandler(t, sb.String(), 7200)}}
	w3 := &fakeWriter{maxMin: 60}
	_, sm3 := newModules(w3, c3, nil)
	if err := sm3.Run(context.Background(), newJob(t, []string{in}, ix.SpeechOptions{Force: true}, nil)); err != nil {
		t.Fatal(err)
	}
	if r := w3.speech[0]; r.NoSpeech || len(r.Chunks) < 100 {
		t.Errorf("forced long file = nospeech %v, %d chunks", r.NoSpeech, len(r.Chunks))
	}
}

func srtTime(ms int64) string {
	return fmt.Sprintf("%02d:%02d:%02d,%03d", ms/3_600_000, ms/60_000%60, ms/1000%60, ms%1000)
}

func TestSpeechNoAudioAndLittleSpeech(t *testing.T) {
	in := speechInput(t)
	withProbe(t, media.Info{DurationMs: 30_000})
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){}}
	w := &fakeWriter{maxMin: 60}
	_, sm := newModules(w, c, nil)
	if err := sm.Run(context.Background(), newJob(t, []string{in}, ix.SpeechOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	if r := w.speech[0]; !r.NoSpeech || len(c.calls) != 0 {
		t.Errorf("no audio stream = %+v, calls %d", r, len(c.calls))
	}

	// A 10 min file with a 5 s mumble: 0.8% speech.
	withProbe(t, media.Info{DurationMs: 600_000, Audio: []media.AudioStream{{Index: 1}}})
	c2 := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){
		"transcribe.run": transcribeHandler(t, "1\n00:01:00,000 --> 00:01:05,000\nhm\n\n", 600),
	}}
	w2 := &fakeWriter{maxMin: 60}
	_, sm2 := newModules(w2, c2, nil)
	if err := sm2.Run(context.Background(), newJob(t, []string{in}, ix.SpeechOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	if r := w2.speech[0]; !r.NoSpeech || len(r.Chunks) != 0 {
		t.Errorf("little speech = %+v", r)
	}

	// An empty transcript is no speech too.
	c3 := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"transcribe.run": transcribeHandler(t, "", 600)}}
	w3 := &fakeWriter{maxMin: 60}
	_, sm3 := newModules(w3, c3, nil)
	if err := sm3.Run(context.Background(), newJob(t, []string{in}, ix.SpeechOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	if !w3.speech[0].NoSpeech {
		t.Errorf("empty transcript = %+v", w3.speech[0])
	}
}

func TestSpeechReusesTranscriptsFromLineage(t *testing.T) {
	in := speechInput(t)
	dir := t.TempDir()
	srt := filepath.Join(dir, "talk.srt")
	_ = os.WriteFile(srt, []byte(twoCueSRT), 0o644)
	js := filepath.Join(dir, "talk.json")
	_ = os.WriteFile(js, []byte(`{"language":"en","duration":12,"segments":[{"start":0.5,"end":2.5,"text":" From json "}]}`), 0o644)

	for name, trs := range map[string][]string{"srt": {srt}, "json": {js}, "skips unreadable": {filepath.Join(dir, "none.srt"), js}} {
		c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){}}
		w := &fakeWriter{maxMin: 60, transcripts: map[string][]string{in: trs}}
		_, sm := newModules(w, c, nil)
		// Even with the engine and FFmpeg missing: reuse needs neither.
		job := newJob(t, []string{in}, ix.SpeechOptions{}, map[string]bool{sidecar.DepID: true, deps.FFmpeg: true, deps.FFprobe: true})
		if err := sm.Run(context.Background(), job); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(c.calls) != 0 || len(w.speech) != 1 {
			t.Fatalf("%s: calls %d, stored %d", name, len(c.calls), len(w.speech))
		}
		r := w.speech[0]
		if r.NoSpeech || len(r.Chunks) != 1 || r.Chunks[0].Source != core.TextSourceSubs {
			t.Errorf("%s: %+v", name, r)
		}
		if name == "srt" && (r.Chunks[0].Pos != 1000 || r.Chunks[0].EndPos != 10_000) {
			t.Errorf("srt chunk = %+v", r.Chunks[0])
		}
		if name != "srt" && (r.Chunks[0].Text != "From json" || r.Chunks[0].Pos != 500 || r.Chunks[0].EndPos != 2500) {
			t.Errorf("json chunk = %+v", r.Chunks[0])
		}
	}
}

func TestSpeechEngineMissingFailsTheJob(t *testing.T) {
	in := speechInput(t)
	withProbe(t, media.Info{DurationMs: 20_000, Audio: []media.AudioStream{{Index: 1}}})
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){}}
	w := &fakeWriter{maxMin: 60}
	_, sm := newModules(w, c, nil)
	err := sm.Run(context.Background(), newJob(t, []string{in}, ix.SpeechOptions{}, map[string]bool{sidecar.DepID: true}))
	if !core.IsCode(err, core.CodeDependencyMissing) || len(w.speech) != 0 {
		t.Errorf("err = %v, stored %d", err, len(w.speech))
	}
	// A missing file is recorded as failed.
	w2 := &fakeWriter{maxMin: 60}
	_, sm2 := newModules(w2, c, nil)
	if err := sm2.Run(context.Background(), newJob(t, []string{filepath.Join(t.TempDir(), "gone.mp4")}, ix.SpeechOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	if w2.speech[0].Failed == "" {
		t.Errorf("missing file = %+v", w2.speech[0])
	}
	// Validate wants exactly one input.
	if err := sm.Validate([]string{"a", "b"}, nil); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("Validate = %v", err)
	}
}
