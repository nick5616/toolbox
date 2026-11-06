package compress

import (
	"strings"
	"testing"
)

func TestTargetsAreWellFormed(t *testing.T) {
	seen := map[string]bool{}
	groups := map[string]bool{"Chat": true, "Email": true, "Social": true, "Work": true, "Fun": true}
	for _, tg := range Targets() {
		if tg.ID == "" || tg.ID == CustomTarget || seen[tg.ID] {
			t.Errorf("bad or duplicate id %q", tg.ID)
		}
		seen[tg.ID] = true
		if tg.Label == "" || tg.Bytes <= 0 || !groups[tg.Group] {
			t.Errorf("target %+v", tg)
		}
	}
	if d, ok := TargetByID(DefaultOptions().TargetID); !ok || d.Bytes != 20_000_000 {
		t.Errorf("default target %+v %v", d, ok)
	}
}

func TestOptionsValidateAndLimit(t *testing.T) {
	if err := DefaultOptions().Validate(); err != nil {
		t.Fatalf("defaults invalid: %v", err)
	}
	tests := []struct {
		name  string
		edit  func(*Options)
		field string
		limit int64
	}{
		{"preset wins over mb", func(o *Options) { o.TargetID, o.TargetMB = "gmail", 1 }, "", 18_000_000},
		{"custom", func(o *Options) { o.TargetID, o.TargetMB = CustomTarget, 7.5 }, "", 7_500_000},
		{"custom too small", func(o *Options) { o.TargetID, o.TargetMB = CustomTarget, 0.01 }, "targetMb", 0},
		{"unknown target", func(o *Options) { o.TargetID = "myspace" }, "targetId", 0},
		{"bad height", func(o *Options) { o.MaxHeight = 999 }, "maxHeight", 0},
		{"bad codec", func(o *Options) { o.VideoCodec = "av1" }, "videoCodec", 0},
		{"bad too small", func(o *Options) { o.IfTooSmall = "" }, "ifTooSmall", 0},
		{"bad image format", func(o *Options) { o.ImageFormat = "gif" }, "imageFormat", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := DefaultOptions()
			tt.edit(&o)
			err := o.Validate()
			if tt.field == "" {
				if err != nil {
					t.Fatalf("unexpected %v", err)
				}
				if got := o.Limit(); got != tt.limit {
					t.Errorf("limit %d, want %d", got, tt.limit)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "validation") {
				t.Fatalf("want a validation error on %s, got %v", tt.field, err)
			}
		})
	}
}

func TestFormatBytes(t *testing.T) {
	for n, want := range map[int64]string{
		512: "512 B", 850_000: "850 KB", 1_474_560: "1.5 MB", 12_400_000: "12.4 MB", 20_000_000: "20 MB",
		512_000_000: "512 MB", 2_000_000_000: "2 GB", 1_250_000_000: "1.25 GB",
	} {
		if got := FormatBytes(n); got != want {
			t.Errorf("FormatBytes(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestKindOf(t *testing.T) {
	for p, want := range map[string]Kind{
		"a.MP4": KindVideo, "a.mov": KindVideo, "a.mp3": KindAudio, "a.flac": KindAudio, "a.gif": KindGIF,
		"a.HEIC": KindImage, "a.png": KindImage, "a.pdf": KindPDF, "a.pptx": KindOffice, "a.docx": KindOffice,
		"a.zip": KindOther, "a": KindOther, "a.psd": KindOther,
	} {
		if got := KindOf(p); got != want {
			t.Errorf("KindOf(%q) = %s, want %s", p, got, want)
		}
	}
}

func TestStepSummary(t *testing.T) {
	o := DefaultOptions()
	if got := stepSummary(o); got != "under 20 MB (Discord)" {
		t.Errorf("summary %q", got)
	}
	o.TargetID, o.TargetMB, o.IfTooSmall, o.MaxHeight = CustomTarget, 8, TooSmallSplit, 720
	if got := stepSummary(o); got != "under 8 MB · split if needed · ≤ 720p" {
		t.Errorf("summary %q", got)
	}
}
