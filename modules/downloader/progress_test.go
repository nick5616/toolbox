package downloader

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

type fixtureLine struct {
	text   string
	stderr bool
}

func loadFixture(t testing.TB, name string) []fixtureLine {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()
	var out []fixtureLine
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		l := strings.TrimRight(sc.Text(), "\r")
		if rest, ok := strings.CutPrefix(l, "stderr:"); ok {
			out = append(out, fixtureLine{rest, true})
		} else {
			out = append(out, fixtureLine{l, false})
		}
	}
	return out
}

func TestParseLine(t *testing.T) {
	tests := []struct {
		name string
		line string
		want Event
	}{
		{"start single", "[tbx:start] abc|251|NA|NA|Me at the zoo",
			Event{Kind: EvStart, ID: "abc", FormatID: "251", Title: "Me at the zoo"}},
		{"start playlist with pipe in title", "[tbx:start] abc|133+140|2|10|A | B | C",
			Event{Kind: EvStart, ID: "abc", FormatID: "133+140", PlaylistIndex: 2, PlaylistCount: 10, Title: "A | B | C"}},
		{"start floats as indices", "[tbx:start] abc|NA|3.0|None|T",
			Event{Kind: EvStart, ID: "abc", PlaylistIndex: 3, Title: "T"}},
		{"download", "[tbx:dl] downloading|1024|252182|NA|405070.95|2|NA|NA",
			Event{Kind: EvDownload, Status: "downloading", Downloaded: 1024, Total: 252182, TotalEstimate: -1, Speed: 405070.95, ETA: 2}},
		{"download finished NA", "[tbx:dl] finished|100|100|NA|12.5|NA|1|3",
			Event{Kind: EvDownload, Status: "finished", Downloaded: 100, Total: 100, TotalEstimate: -1, Speed: 12.5, ETA: -1, PlaylistIndex: 1, PlaylistCount: 3}},
		{"download None and empty", "[tbx:dl] downloading|5|None||None||NA|NA",
			Event{Kind: EvDownload, Status: "downloading", Downloaded: 5, Total: -1, TotalEstimate: -1, Speed: -1, ETA: -1}},
		{"download short", "[tbx:dl] downloading|5",
			Event{Kind: EvDownload, Status: "downloading", Downloaded: 5, Total: -1, TotalEstimate: -1, Speed: -1, ETA: -1}},
		{"download float bytes", "[tbx:dl] downloading|1.5e3|3000.0|NA|NA|NA|NA|NA",
			Event{Kind: EvDownload, Status: "downloading", Downloaded: 1500, Total: 3000, TotalEstimate: -1, Speed: -1, ETA: -1}},
		{"pp", "[tbx:pp] started|ExtractAudio", Event{Kind: EvPostprocess, PPStatus: "started", Postprocessor: "ExtractAudio"}},
		{"out", `[tbx:out] C:\x\Me [a|b].mp3`, Event{Kind: EvOutput, Path: `C:\x\Me [a|b].mp3`}},
		{"error", "ERROR: [youtube] x: Video unavailable", Event{Kind: EvError, Message: "[youtube] x: Video unavailable"}},
		{"other", "[youtube] Extracting URL", Event{Kind: EvOther}},
		{"warning", "WARNING: something", Event{Kind: EvOther}},
		{"empty", "", Event{Kind: EvOther}},
		{"unknown tbx", "[tbx:zzz] hi", Event{Kind: EvOther}},
		{"garbage numbers", "[tbx:dl] x|abc|def|||||", Event{Kind: EvDownload, Status: "x", Downloaded: -1, Total: -1, TotalEstimate: -1, Speed: -1, ETA: -1}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseLine(tc.line); got != tc.want {
				t.Fatalf("ParseLine(%q)\n got  %+v\n want %+v", tc.line, got, tc.want)
			}
		})
	}
}

type replay struct {
	pcts     []float64
	msgs     []string
	title    string
	outputs  []string
	lastErr  string
	sawIndet bool
}

func replayFixture(t *testing.T, name string, trim bool) replay {
	t.Helper()
	tr := NewTracker()
	tr.SetTrim(trim)
	var r replay
	for _, l := range loadFixture(t, name) {
		ev := ParseLine(l.text)
		switch ev.Kind {
		case EvStart:
			if r.title == "" {
				r.title = ev.Title
			}
		case EvOutput:
			r.outputs = append(r.outputs, ev.Path)
		case EvError:
			r.lastErr = ev.Message
		}
		if pct, msg, changed := tr.Apply(ev); changed {
			r.pcts = append(r.pcts, pct)
			r.msgs = append(r.msgs, msg)
			if pct == core.IndeterminateProgress {
				r.sawIndet = true
			}
		}
	}
	return r
}

func assertMonotonic(t *testing.T, pcts []float64) {
	t.Helper()
	prev := 0.0
	for i, p := range pcts {
		if p == core.IndeterminateProgress {
			continue
		}
		if p < prev {
			t.Fatalf("pct decreased at %d: %v -> %v (%v)", i, prev, p, pcts)
		}
		if p < 0 || p > 1 {
			t.Fatalf("pct out of range: %v", p)
		}
		prev = p
	}
}

func hasMsg(msgs []string, sub string) bool {
	for _, m := range msgs {
		if strings.Contains(m, sub) {
			return true
		}
	}
	return false
}

func TestGoldenReplay(t *testing.T) {
	tests := []struct {
		file      string
		trim      bool
		title     string
		outputs   int
		wantFinal bool
		wantIndet bool
		msgs      []string
		wantErr   string
	}{
		{"audio_mp3.txt", false, "Me at the zoo", 1, true, true,
			[]string{"Downloading · ", "Extracting audio", "Converting thumbnail", "Writing metadata", "Embedding thumbnail", "Finalizing", "Done"}, ""},
		{"video_merge_2streams.txt", false, "Me at the zoo", 1, true, true,
			[]string{"Downloading video", "Downloading audio", "Merging streams", "Remuxing"}, ""},
		{"unknown_total.txt", false, "Live stream | part 1", 1, true, true,
			[]string{"Downloading · 12.3 MiB"}, ""},
		{"trim_section.txt", true, "Me at the zoo", 1, true, true,
			[]string{"Downloading section…", "Remuxing"}, ""},
		{"playlist_3.txt", false, "First clip", 3, true, true,
			[]string{"Item 1/3 · ", "Item 2/3 · ", "Item 3/3 · "}, ""},
		{"error_unavailable.txt", false, "", 0, false, false, nil, "[youtube] deadbeef000: Video unavailable. This video is private"},
	}
	for _, tc := range tests {
		t.Run(tc.file, func(t *testing.T) {
			r := replayFixture(t, tc.file, tc.trim)
			assertMonotonic(t, r.pcts)
			if r.title != tc.title {
				t.Errorf("title = %q, want %q", r.title, tc.title)
			}
			if len(r.outputs) != tc.outputs {
				t.Errorf("outputs = %d, want %d", len(r.outputs), tc.outputs)
			}
			if tc.wantFinal {
				if got := r.pcts[len(r.pcts)-1]; got != 1.0 {
					t.Errorf("final pct = %v, want 1.0", got)
				}
			}
			if tc.wantIndet != r.sawIndet {
				t.Errorf("sawIndeterminate = %v, want %v", r.sawIndet, tc.wantIndet)
			}
			for _, m := range tc.msgs {
				if !hasMsg(r.msgs, m) {
					t.Errorf("no message containing %q in %q", m, r.msgs)
				}
			}
			if r.lastErr != tc.wantErr {
				t.Errorf("last error = %q, want %q", r.lastErr, tc.wantErr)
			}
		})
	}
}

func TestTrimNeverShowsDeterminateBeforePostprocess(t *testing.T) {
	r := replayFixture(t, "trim_section.txt", true)
	// start, lone "finished", then pp started: the first determinate value
	// must come only with the first postprocessor.
	first := -1
	for i, p := range r.pcts {
		if p != core.IndeterminateProgress {
			first = i
			break
		}
	}
	if first < 0 || !strings.Contains(r.msgs[first], "Converting thumbnail") {
		t.Fatalf("first determinate at %d msgs=%q", first, r.msgs)
	}
	if r.pcts[first] < 0.9 {
		t.Errorf("expected >= 0.9 after download, got %v", r.pcts[first])
	}
}

func TestTrackerStreamFractions(t *testing.T) {
	tr := NewTracker()
	tr.Apply(ParseLine("[tbx:start] a|133+140|NA|NA|T"))
	pct, msg, _ := tr.Apply(ParseLine("[tbx:dl] downloading|50|100|NA|1048576|30|NA|NA"))
	if pct < 0.224 || pct > 0.226 {
		t.Errorf("pct = %v, want 0.225", pct)
	}
	if msg != "Downloading video · 1.0 MiB/s · ETA 0:30" {
		t.Errorf("msg = %q", msg)
	}
	tr.Apply(ParseLine("[tbx:dl] finished|100|100|NA|1|NA|NA|NA"))
	pct, msg, _ = tr.Apply(ParseLine("[tbx:dl] downloading|50|100|NA|NA|NA|NA|NA"))
	if pct < 0.674 || pct > 0.676 {
		t.Errorf("pct = %v, want 0.675", pct)
	}
	if msg != "Downloading audio" {
		t.Errorf("msg = %q", msg)
	}
	if _, _, changed := tr.Apply(ParseLine("[tbx:dl] downloading|50|100|NA|NA|NA|NA|NA")); changed {
		t.Error("identical event reported as changed")
	}
	if _, _, changed := tr.Apply(ParseLine("[youtube] noise")); changed {
		t.Error("noise reported as changed")
	}
}

func TestFormatHelpers(t *testing.T) {
	if got := formatBytes(4.2 * 1024 * 1024); got != "4.2 MiB" {
		t.Errorf("formatBytes = %q", got)
	}
	if got := formatBytes(512); got != "512 B" {
		t.Errorf("formatBytes = %q", got)
	}
	if got := formatETA(31); got != "0:31" {
		t.Errorf("formatETA = %q", got)
	}
	if got := formatETA(3723); got != "1:02:03" {
		t.Errorf("formatETA = %q", got)
	}
	if got := ppMessage("Whatever"); got != "Whatever" {
		t.Errorf("ppMessage = %q", got)
	}
}

func TestRuntimeSupported(t *testing.T) {
	tests := []struct {
		name, out string
		want      bool
	}{
		{"deno", "deno 2.3.0 (stable, release, x86_64-pc-windows-msvc)\nv8 13.0", true},
		{"deno", "deno 2.5.1 (stable)", true},
		{"deno", "deno 2.2.9 (stable)", false},
		{"deno", "deno 1.46.3 (stable)", false},
		{"deno", "deno 3.0.0", true},
		{"node", "v22.0.0", true},
		{"node", "v24.22.1\n", true},
		{"node", "v20.18.0", false},
		{"node", "v21.9.9", false},
		{"node", "garbage", false},
		{"bun", "1.2.3", false},
		{"deno", "", false},
	}
	for _, tc := range tests {
		if got := runtimeSupported(tc.name, tc.out); got != tc.want {
			t.Errorf("runtimeSupported(%q, %q) = %v, want %v", tc.name, tc.out, got, tc.want)
		}
	}
}
