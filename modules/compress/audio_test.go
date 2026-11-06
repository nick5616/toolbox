package compress

import (
	"strings"
	"testing"
)

func TestPlanAudioSingle(t *testing.T) {
	tests := []struct {
		name     string
		durMs    int64
		budget   int64
		possible bool
		codec    AudioCodec
		kbps     int
		mono     bool
		rate     int
		grade    Grade
		summary  string
	}{
		{"short and roomy: 320", 60_000, 5_000_000, true, AudioMP3, 320, false, 0, GradeGreat, "MP3 320 kb/s"},
		{"mp3 128", 240_000, 3_900_000, true, AudioMP3, 128, false, 0, GradeGreat, "MP3 128 kb/s"},
		{"mp3 96 is good", 300_000, 3_700_000, true, AudioMP3, 96, false, 0, GradeGood, "MP3 96 kb/s"},
		{"mp3 64 is fair, still stereo", 300_000, 2_500_000, true, AudioMP3, 64, false, 0, GradeFair, ""},
		{"below 64 goes mono 22 kHz", 600_000, 3_000_000, true, AudioMP3, 32, true, 22050, GradePoor, "MP3 32 kb/s"},
		{"mp3 48 mono", 600_000, 4_000_000, true, AudioMP3, 48, true, 22050, GradePoor, ""},
		{"opus 24 mono", 1_800_000, 5_300_000, true, AudioOpus, 23, true, 0, GradePoor, "Opus 23 kb/s mono"},
		{"opus 31 stereo", 1_000_000, 3_800_000, true, AudioOpus, 30, false, 0, GradePoor, "Opus 30 kb/s"},
		{"under 6 kb/s impossible", 3_600_000, 1_000_000, false, "", 0, false, 0, GradeNone, ""},
		{"no duration", 0, 1_000_000, false, "", 0, false, 0, GradeNone, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := planAudioSingle(tc.durMs, tc.budget)
			if p.Possible != tc.possible {
				t.Fatalf("possible = %v: %+v", p.Possible, p)
			}
			if !tc.possible {
				return
			}
			if p.Codec != tc.codec || p.Kbps != tc.kbps || p.Mono != tc.mono || p.SampleRate != tc.rate || p.Grade != tc.grade {
				t.Errorf("got %+v, want codec %s kbps %d mono %v rate %d grade %s", p, tc.codec, tc.kbps, tc.mono, tc.rate, tc.grade)
			}
			if tc.summary != "" && p.Summary() != tc.summary {
				t.Errorf("summary = %q, want %q", p.Summary(), tc.summary)
			}
			// It fits.
			if bytes := float64(p.Kbps) * 1000 / 8 * float64(tc.durMs) / 1000; bytes > float64(tc.budget) {
				t.Errorf("needs %.0f bytes, budget %d", bytes, tc.budget)
			}
		})
	}
}

func TestPlanAudioLadder(t *testing.T) {
	// Every result is a standard CBR rate or an Opus rate in range.
	for raw := 5; raw < 400; raw += 3 {
		budget := int64(raw) * 1000 / 8 * 100 // 100 s
		p := planAudioSingle(100_000, budget)
		if raw < 7 {
			continue
		}
		if !p.Possible {
			if raw >= 8 {
				t.Errorf("raw %d should be possible", raw)
			}
			continue
		}
		if p.Codec == AudioMP3 {
			ok := false
			for _, k := range mp3Ladder {
				ok = ok || k == p.Kbps
			}
			if !ok || p.Ext() != ".mp3" {
				t.Errorf("raw %d: mp3 %d not on the ladder", raw, p.Kbps)
			}
		} else if p.Kbps < opusMinKbps || p.Kbps > opusMaxKbps || p.Ext() != ".ogg" {
			t.Errorf("raw %d: opus %d", raw, p.Kbps)
		}
	}
}

func TestPlanAudioSplit(t *testing.T) {
	split := vopts(func(o *Options) { o.IfTooSmall = TooSmallSplit })
	// 1 hour into 20 MB is 44 kb/s: poor. Split: fair needs 64 kb/s.
	p := planAudio(3_600_000, 19_400_000, split)
	if p.Parts < 2 || !atLeastFair(p.Grade) || p.Codec != AudioMP3 {
		t.Fatalf("split plan %+v", p)
	}
	if q := planAudioSingle(partDur(3_600_000, p.Parts-1), 19_400_000); p.Parts > 2 && atLeastFair(q.Grade) {
		t.Errorf("not the fewest parts")
	}
	if !strings.HasPrefix(p.Describe(), "2 parts · MP3") && p.Parts == 2 {
		t.Errorf("describe %q", p.Describe())
	}
	// Lower keeps one file.
	if q := planAudio(3_600_000, 19_400_000, vopts(nil)); q.Parts != 1 {
		t.Errorf("lower split into %d", q.Parts)
	}
	// Fine as one file: not split.
	if q := planAudio(180_000, 3_000_000, split); q.Parts != 1 {
		t.Errorf("fine audio split into %d", q.Parts)
	}
	// Hopeless: impossible.
	if q := planAudio(3_600_000*1000, 100_000, split); q.Possible {
		t.Errorf("should be impossible: %+v", q)
	}
}

func TestAudioArgs(t *testing.T) {
	o := DefaultOptions()
	mp3 := strings.Join(audioArgs(AudioPlan{Codec: AudioMP3, Kbps: 48, Mono: true, SampleRate: 22050}, 48, "in.wav", partRange{}, false, o, "o.mp3"), " ")
	for _, want := range []string{"-i in.wav", "-vn", "-map 0:a:0", "-c:a libmp3lame", "-b:a 48k", "-ac 1", "-ar 22050", "-map_metadata -1"} {
		if !strings.Contains(mp3, want) {
			t.Errorf("mp3 missing %q in %s", want, mp3)
		}
	}
	opus := strings.Join(audioArgs(AudioPlan{Codec: AudioOpus, Kbps: 20, Mono: true}, 18, "in.wav", partRange{StartMs: 5000, DurMs: 2500}, true,
		vopts(func(o *Options) { o.KeepMetadata = true }), "o.ogg"), " ")
	for _, want := range []string{"-ss 5.000 -t 2.500 -i in.wav", "-c:a libopus", "-b:a 18k", "-vbr on", "-ac 1"} {
		if !strings.Contains(opus, want) {
			t.Errorf("opus missing %q in %s", want, opus)
		}
	}
	if strings.Contains(opus, "map_metadata") || strings.Contains(opus, "-ar") {
		t.Errorf("unexpected flags: %s", opus)
	}
}

func TestNextAudioKbps(t *testing.T) {
	mp3 := AudioPlan{Codec: AudioMP3}
	if got := nextAudioKbps(mp3, 128); got != 112 {
		t.Errorf("128 -> %d", got)
	}
	if got := nextAudioKbps(mp3, 32); got != 0 {
		t.Errorf("32 -> %d", got)
	}
	op := AudioPlan{Codec: AudioOpus}
	if got := nextAudioKbps(op, 20); got != 17 {
		t.Errorf("opus 20 -> %d", got)
	}
	if got := nextAudioKbps(op, 6); got != 0 {
		t.Errorf("opus 6 -> %d", got)
	}
}
