package editstudio

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core/lyrics"
)

func TestWriteSRT(t *testing.T) {
	m := newTestModule(t)
	tests := []struct {
		name    string
		req     TextRequest
		want    string
		file    string
		wantErr bool
	}{
		{"basic", TextRequest{Kind: TextSRT, Name: "My edit", Cues: []lyrics.Line{{StartMs: 0, EndMs: 1500, Text: "hello"}, {StartMs: 2000, EndMs: 3250, Text: "world"}}},
			"1\n00:00:00,000 --> 00:00:01,500\nhello\n", "My edit.srt", false},
		{"unsafe name and negatives", TextRequest{Kind: TextSRT, Name: "a/b:c", Cues: []lyrics.Line{{StartMs: -5, EndMs: -1, Text: "x"}}},
			"00:00:00,000 --> 00:00:00,000", "a_b_c.srt", false},
		{"empty", TextRequest{Kind: TextSRT, Name: "e"}, "", "", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := &recorder{}
			job := newJob(t, t.TempDir(), Options{Action: ActionText, Text: &tc.req}, rec, nil)
			err := m.writeSRT(context.Background(), job, tc.req)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			p := filepath.Join(job.OutputDir, tc.file)
			b, rerr := os.ReadFile(p)
			if rerr != nil {
				t.Fatal(rerr)
			}
			if !strings.Contains(string(b), tc.want) {
				t.Fatalf("file = %q, want it to contain %q", b, tc.want)
			}
			if len(rec.outputs) != 1 || rec.outputs[0] != p {
				t.Fatalf("outputs = %v", rec.outputs)
			}
			var res Result
			if err := json.Unmarshal(rec.result, &res); err != nil || res.Action != ActionText || len(res.Outputs) != 1 {
				t.Fatalf("result = %s (%v)", rec.result, err)
			}
		})
	}
}

func TestWriteSRTUniquePath(t *testing.T) {
	m := newTestModule(t)
	req := TextRequest{Kind: TextSRT, Name: "x", Cues: []lyrics.Line{{StartMs: 0, EndMs: 1, Text: "a"}}}
	rec := &recorder{}
	job := newJob(t, t.TempDir(), Options{Action: ActionText, Text: &req}, rec, nil)
	for range 2 {
		if err := m.writeSRT(context.Background(), job, req); err != nil {
			t.Fatal(err)
		}
	}
	if len(rec.outputs) != 2 || rec.outputs[0] == rec.outputs[1] {
		t.Fatalf("outputs = %v", rec.outputs)
	}
}
