package videoeditor

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// The FFmpeg filtergraph builder (SPEC.md Part B §B6.2). buildPlan is pure:
// (document, probes, frame size, preview flag) in, arguments and graph text
// out, so it is golden-tested without FFmpeg.

const (
	audioRate   = 48000
	audioBps    = 192000.0
	sizeSafety  = 0.97
	minKbps     = 150
	motionScale = 1.5 // photos with motion are framed larger, then zoompan crops
	motionZoom  = 0.25
)

// graphIn is everything buildPlan needs.
type graphIn struct {
	Doc VideoProject // normalized
	// Infos are the probes by source path (video clips and the song).
	Infos map[string]ClipInfo
	// Images maps a photo clip's index to the file FFmpeg reads (pre-oriented).
	Images     map[int]string
	W, H       int
	Preview    bool
	MaxMs      int64  // 0 = no cap
	GraphFile  string // name of the filter script file, relative to the working dir
	ASSName    string // name of the titles file
	OutputPath string
}

// ffPlan is a ready FFmpeg invocation.
type ffPlan struct {
	Args  []string
	Graph string // contents of GraphFile
	ASS   string // contents of ASSName; "" = no titles
	OutMs int64  // output length
}

// frameSize is the output frame for an aspect, optionally scaled so the short
// side is previewShort.
func frameSize(aspect string, preview bool) (w, h int) {
	switch aspect {
	case "9:16":
		w, h = 1080, 1920
	case "4:5":
		w, h = 1080, 1350
	case "1:1":
		w, h = 1080, 1080
	default:
		w, h = 1920, 1080
	}
	if preview {
		w, h = previewSize(w, h)
	}
	return w, h
}

const previewShort = 540

// previewSize scales (w, h) so the short side is 540.
func previewSize(w, h int) (int, int) {
	s := float64(previewShort) / float64(min(w, h))
	return even(int(math.Round(float64(w) * s))), even(int(math.Round(float64(h) * s)))
}

func even(v int) int { return v &^ 1 }

// num formats a float for a filter argument.
func num(v float64) string {
	return strconv.FormatFloat(math.Round(v*10000)/10000, 'f', -1, 64)
}

// frames is a clip length in 30 fps frames.
func frames(ms int64) int { return max(1, int(math.Round(float64(ms)*FPS/1000))) }

// sec formats frames as seconds.
func sec(fr int) string { return num(float64(fr) / FPS) }

// lookFilter is the FFmpeg preset of a look ("" = none).
func lookFilter(look string) string {
	switch look {
	case "vivid":
		return "eq=saturation=1.35:contrast=1.08"
	case "warm":
		return "colorchannelmixer=rr=1.06:bb=0.92"
	case "cool":
		return "colorchannelmixer=rr=0.93:bb=1.07"
	case "mono":
		return "eq=saturation=0:contrast=1.05"
	case "fade":
		return "eq=contrast=0.88:brightness=0.04:saturation=0.85"
	case "noir":
		return "eq=saturation=0:contrast=1.35:brightness=-0.04"
	}
	return ""
}

func ffColor(hex string) string { return "0x" + strings.TrimPrefix(hex, "#") }

// atempoChain splits a speed into atempo stages within 0.5–2.
func atempoChain(speed float64) []string {
	var out []string
	for speed < 0.5 {
		out = append(out, "atempo=0.5")
		speed /= 0.5
	}
	for speed > 2 {
		out = append(out, "atempo=2")
		speed /= 2
	}
	return append(out, "atempo="+num(speed))
}

// videoStatements builds clip i's video: the filter statements, ending in the
// label [v<i>]. n is the clip's length in frames.
func videoStatements(i int, c Clip, src string, w, h, n int) []string {
	k := 1.0
	motion := c.Kind == "image" && c.Motion != "none"
	if motion {
		k = motionScale
	}
	fw, fh := even(int(math.Round(float64(w)*k))), even(int(math.Round(float64(h)*k)))

	var stmts []string
	head := "[" + src + "]"
	var chain []string
	if c.Kind == "video" && c.Speed != 1 {
		chain = append(chain, "setpts=(PTS-STARTPTS)/"+num(c.Speed))
	} else {
		chain = append(chain, "setpts=PTS-STARTPTS")
	}

	switch c.Fit {
	case "fit-blur":
		bw, bh := max(2, fw/4), max(2, fh/4)
		chain = append(chain, "split=2[bs"+strconv.Itoa(i)+"][fs"+strconv.Itoa(i)+"]")
		stmts = append(stmts, head+strings.Join(chain, ","))
		stmts = append(stmts,
			fmt.Sprintf("[bs%d]scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,gblur=sigma=8,scale=%d:%d,eq=brightness=-0.1[bg%d]", i, bw, bh, bw, bh, fw, fh, i),
			fmt.Sprintf("[fs%d]scale=%d:%d:force_original_aspect_ratio=decrease[fg%d]", i, fw, fh, i),
		)
		head = fmt.Sprintf("[bg%d][fg%d]", i, i)
		chain = []string{"overlay=(W-w)/2:(H-h)/2"}
	case "fit-color":
		chain = append(chain,
			fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease", fw, fh),
			fmt.Sprintf("pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=%s", fw, fh, ffColor(c.FitColor)))
	default: // fill
		zw, zh := even(int(math.Round(float64(fw)*c.Zoom))), even(int(math.Round(float64(fh)*c.Zoom)))
		chain = append(chain,
			fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=increase", zw, zh),
			fmt.Sprintf("crop=%d:%d:(iw-ow)/2*%s:(ih-oh)/2*%s", fw, fh, num(1+c.PanX), num(1+c.PanY)))
	}

	if motion {
		chain = append(chain, zoompan(c.Motion, n, w, h))
	}
	if lf := lookFilter(c.Look); lf != "" {
		chain = append(chain, lf)
	}
	chain = append(chain, "fps="+strconv.Itoa(FPS), "format=yuv420p", "setsar=1",
		"tpad=stop_mode=clone:stop_duration=1", fmt.Sprintf("trim=end_frame=%d", n), "setpts=PTS-STARTPTS")
	stmts = append(stmts, head+strings.Join(chain, ",")+fmt.Sprintf("[v%d]", i))
	return stmts
}

// zoompan is the Ken Burns motion over n output frames. Each looped input
// frame yields one output frame (d=1) and the zoom follows the output frame
// number.
func zoompan(motion string, n, w, h int) string {
	nn := strconv.Itoa(max(n-1, 1))
	var z, x string
	y := "ih/2-(ih/zoom/2)"
	switch motion {
	case "in":
		z, x = fmt.Sprintf("1+%s*on/%s", num(motionZoom), nn), "iw/2-(iw/zoom/2)"
	case "out":
		z, x = fmt.Sprintf("1+%s-%s*on/%s", num(motionZoom), num(motionZoom), nn), "iw/2-(iw/zoom/2)"
	case "left":
		z, x = "1.2", fmt.Sprintf("(iw-iw/zoom)*(1-on/%s)", nn)
	default: // right
		z, x = "1.2", fmt.Sprintf("(iw-iw/zoom)*on/%s", nn)
	}
	return fmt.Sprintf("zoompan=z='%s':x='%s':y='%s':d=1:s=%dx%d:fps=%d", z, x, y, w, h, FPS)
}

// audioStatement builds clip i's audio ending in [a<i>]; lenFr is the clip
// length in frames. src is "" for silence.
func audioStatement(i int, c Clip, src string, lenFr int) string {
	l := sec(lenFr)
	if src == "" || c.Volume <= 0 {
		return fmt.Sprintf("anullsrc=r=%d:cl=stereo,atrim=duration=%s,asetpts=PTS-STARTPTS[a%d]", audioRate, l, i)
	}
	chain := []string{fmt.Sprintf("aformat=sample_rates=%d:channel_layouts=stereo", audioRate)}
	if c.Speed != 1 {
		chain = append(chain, atempoChain(c.Speed)...)
	}
	if c.Volume != 1 {
		chain = append(chain, "volume="+num(c.Volume))
	}
	chain = append(chain, "apad=whole_dur="+l, "atrim=duration="+l, "asetpts=PTS-STARTPTS")
	return "[" + src + "]" + strings.Join(chain, ",") + fmt.Sprintf("[a%d]", i)
}

func xfadeKind(kind string) string {
	switch kind {
	case "dip":
		return "fadeblack"
	case "slide":
		return "slideleft"
	}
	return "fade"
}

// videoBitrateKbps is the x264 target (kbit/s) for a file of maxMB holding
// durSec seconds with audioRate bit/s of audio (Trimmer's formula).
func videoBitrateKbps(maxMB int, audioRate, durSec float64) float64 {
	if durSec <= 0 {
		return 0
	}
	total := float64(maxMB) * 8 * 1024 * 1024 * sizeSafety
	return (total - audioRate*durSec) / durSec / 1000
}

// buildPlan builds the FFmpeg invocation for in.
func buildPlan(in graphIn) (ffPlan, error) {
	doc := in.Doc
	clips := doc.Clips
	if len(clips) == 0 {
		return ffPlan{}, vErr("clips", "Add at least one clip")
	}
	var args []string
	args = append(args, "-y", "-hide_banner", "-nostats", "-loglevel", "warning", "-progress", "pipe:1")

	// Inputs: one per clip, then the song.
	lens := make([]int, len(clips)) // frames
	hasAudio := make([]bool, len(clips))
	for i, c := range clips {
		lens[i] = frames(clipLenMs(c))
		switch c.Kind {
		case "image":
			img := in.Images[i]
			if img == "" {
				img = c.Path
			}
			args = append(args, "-loop", "1", "-framerate", strconv.Itoa(FPS), "-t", num(float64(lens[i])/FPS+1), "-i", img)
		default:
			info := in.Infos[c.Path]
			hasAudio[i] = info.HasAudio
			args = append(args, "-ss", num(float64(c.InMs)/1000), "-t", num(float64(c.OutMs-c.InMs)/1000), "-i", c.Path)
		}
	}
	musicIdx := -1
	if doc.Music != nil {
		musicIdx = len(clips)
		args = append(args, "-i", doc.Music.Path)
	}

	var st []string
	for i, c := range clips {
		src := fmt.Sprintf("%d:v:0", i)
		st = append(st, videoStatements(i, c, src, in.W, in.H, lens[i])...)
		asrc := ""
		if hasAudio[i] {
			asrc = fmt.Sprintf("%d:a:0", i)
		}
		st = append(st, audioStatement(i, c, asrc, lens[i]))
	}

	// Joins: runs of cut-joined clips are concatenated, runs are xfaded.
	type run struct{ from, to int }
	var runs []run
	start := 0
	for i := range clips {
		if i == len(clips)-1 || overlapMs(clips, i) > 0 {
			runs = append(runs, run{start, i})
			start = i + 1
		}
	}
	runLabel := func(r run, idx int) (v, a string, n int) {
		if r.from == r.to {
			return fmt.Sprintf("[v%d]", r.from), fmt.Sprintf("[a%d]", r.from), lens[r.from]
		}
		var b strings.Builder
		for i := r.from; i <= r.to; i++ {
			n += lens[i]
			fmt.Fprintf(&b, "[v%d][a%d]", i, i)
		}
		fmt.Fprintf(&b, "concat=n=%d:v=1:a=1[cv%d][ca%d]", r.to-r.from+1, idx, idx)
		st = append(st, b.String(), fmt.Sprintf("[cv%d]fps=%d[rv%d]", idx, FPS, idx))
		return fmt.Sprintf("[rv%d]", idx), fmt.Sprintf("[ca%d]", idx), n
	}
	curV, curA, acc := runLabel(runs[0], 0)
	for ri := 1; ri < len(runs); ri++ {
		prev := runs[ri-1]
		nv, na, n := runLabel(runs[ri], ri)
		t := clips[prev.to].Transition
		dn := frames(overlapMs(clips, prev.to))
		st = append(st,
			fmt.Sprintf("%s%sxfade=transition=%s:duration=%s:offset=%s[xv%d]", curV, nv, xfadeKind(t.Kind), sec(dn), sec(acc-dn), ri),
			fmt.Sprintf("%s%sacrossfade=d=%s:c1=tri:c2=tri[xa%d]", curA, na, sec(dn), ri))
		curV, curA = fmt.Sprintf("[xv%d]", ri), fmt.Sprintf("[xa%d]", ri)
		acc += n - dn
	}
	totalMs := int64(math.Round(float64(acc) * 1000 / FPS))

	// Output length.
	outMs := totalMs
	songRemMs := int64(0)
	if doc.Music != nil {
		songRemMs = max(in.Infos[doc.Music.Path].DurationMs-doc.Music.OffsetMs, 0)
		if doc.Music.EndWithMusic && songRemMs > 0 {
			outMs = min(outMs, songRemMs)
		}
	}
	if in.MaxMs > 0 {
		outMs = min(outMs, in.MaxMs)
	}
	if outMs < MinClipMs {
		return ffPlan{}, vErr("clips", "The video would be too short")
	}

	// Titles.
	vOut := curV
	ass := ""
	if a, ok := buildTitlesASS(doc.Titles, in.W, in.H, outMs); ok {
		ass = a
		st = append(st, fmt.Sprintf("%sass=%s[vt]", curV, in.ASSName))
		vOut = "[vt]"
	}

	// Music.
	aOut := curA
	if musicIdx >= 0 {
		m := doc.Music
		musEnd := outMs
		if songRemMs > 0 {
			musEnd = min(outMs, songRemMs)
		}
		chain := []string{
			fmt.Sprintf("aformat=sample_rates=%d:channel_layouts=stereo", audioRate),
			"atrim=start=" + num(float64(m.OffsetMs)/1000), "asetpts=PTS-STARTPTS",
		}
		if fi := min(m.FadeInMs, musEnd); fi > 0 {
			chain = append(chain, "afade=t=in:st=0:d="+num(float64(fi)/1000))
		}
		if fo := min(m.FadeOutMs, musEnd); fo > 0 {
			chain = append(chain, fmt.Sprintf("afade=t=out:st=%s:d=%s", num(float64(musEnd-fo)/1000), num(float64(fo)/1000)))
		}
		chain = append(chain, "volume="+num(m.Volume))
		st = append(st, fmt.Sprintf("[%d:a:0]%s[mus]", musicIdx, strings.Join(chain, ",")))
		const mixer = "amix=inputs=2:duration=first:normalize=0:dropout_transition=0[aout]"
		if m.Duck {
			st = append(st,
				curA+"asplit=2[amain][akey]",
				"[mus][akey]sidechaincompress=threshold=0.04:ratio=6:attack=15:release=350:makeup=1[mduck]",
				"[amain][mduck]"+mixer)
		} else {
			st = append(st, curA+"[mus]"+mixer)
		}
		aOut = "[aout]"
	}

	args = append(args, "-/filter_complex", in.GraphFile, "-map", vOut, "-map", aOut)

	// Encoder.
	preset, crf := "medium", "20"
	if in.Preview {
		preset, crf = "veryfast", "28"
	}
	args = append(args, "-c:v", "libx264", "-profile:v", "high", "-preset", preset)
	if doc.MaxSizeMB > 0 && !in.Preview {
		kbps := videoBitrateKbps(doc.MaxSizeMB, audioBps, float64(outMs)/1000)
		if kbps < minKbps {
			return ffPlan{}, vErr("maxSizeMB", "This size limit is too small for a video this long")
		}
		k := int(kbps)
		args = append(args, "-b:v", fmt.Sprintf("%dk", k), "-maxrate", fmt.Sprintf("%dk", k+k/10), "-bufsize", fmt.Sprintf("%dk", 2*k))
	} else {
		args = append(args, "-crf", crf)
	}
	args = append(args, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", strconv.Itoa(audioRate),
		"-movflags", "+faststart", "-t", num(float64(outMs)/1000), "-f", "mp4", in.OutputPath)

	return ffPlan{Args: args, Graph: strings.Join(st, ";\n") + "\n", ASS: ass, OutMs: outMs}, nil
}
