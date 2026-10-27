package downloader

import (
	"fmt"
	"strconv"
	"strings"

	"toolbox/core"
)

// EventKind classifies a parsed yt-dlp output line.
type EventKind int

const (
	EvOther EventKind = iota
	EvStart
	EvDownload
	EvPostprocess
	EvOutput
	EvError
)

// Event is one parsed output line. Numeric fields are -1 when NA.
type Event struct {
	Kind EventKind
	// EvStart
	ID, FormatID, Title          string
	PlaylistIndex, PlaylistCount int // 0 if NA
	// EvDownload
	Status                                       string
	Downloaded, Total, TotalEstimate, Speed, ETA float64
	// EvPostprocess
	PPStatus, Postprocessor string
	// EvOutput
	Path string
	// EvError
	Message string
}

const (
	prefixStart = "[tbx:start] "
	prefixDL    = "[tbx:dl] "
	prefixPP    = "[tbx:pp] "
	prefixOut   = "[tbx:out] "
)

func isTbxLine(line string) bool { return strings.HasPrefix(line, "[tbx:") }

func parseNum(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "NA" || s == "None" {
		return -1
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return -1
	}
	return v
}

func parseIndex(s string) int {
	v := parseNum(s)
	if v < 0 {
		return 0
	}
	return int(v)
}

// ParseLine classifies one output line. It never panics.
func ParseLine(line string) Event {
	line = strings.TrimRight(line, "\r\n")
	switch {
	case strings.HasPrefix(line, prefixStart):
		f := strings.SplitN(strings.TrimPrefix(line, prefixStart), "|", 5)
		for len(f) < 5 {
			f = append(f, "")
		}
		return Event{
			Kind: EvStart, ID: f[0], FormatID: naToEmpty(f[1]),
			PlaylistIndex: parseIndex(f[2]), PlaylistCount: parseIndex(f[3]),
			Title: f[4],
		}
	case strings.HasPrefix(line, prefixDL):
		f := strings.Split(strings.TrimPrefix(line, prefixDL), "|")
		for len(f) < 8 {
			f = append(f, "")
		}
		return Event{
			Kind: EvDownload, Status: strings.TrimSpace(f[0]),
			Downloaded: parseNum(f[1]), Total: parseNum(f[2]), TotalEstimate: parseNum(f[3]),
			Speed: parseNum(f[4]), ETA: parseNum(f[5]),
			PlaylistIndex: parseIndex(f[6]), PlaylistCount: parseIndex(f[7]),
		}
	case strings.HasPrefix(line, prefixPP):
		f := strings.SplitN(strings.TrimPrefix(line, prefixPP), "|", 2)
		for len(f) < 2 {
			f = append(f, "")
		}
		return Event{Kind: EvPostprocess, PPStatus: strings.TrimSpace(f[0]), Postprocessor: strings.TrimSpace(f[1])}
	case strings.HasPrefix(line, prefixOut):
		return Event{Kind: EvOutput, Path: strings.TrimSpace(strings.TrimPrefix(line, prefixOut))}
	case strings.HasPrefix(line, "ERROR:"):
		return Event{Kind: EvError, Message: strings.TrimSpace(strings.TrimPrefix(line, "ERROR:"))}
	}
	return Event{Kind: EvOther}
}

func naToEmpty(s string) string {
	if s == "NA" || s == "None" {
		return ""
	}
	return s
}

const (
	dlWeight     = 0.90
	ppStep       = 0.03
	itemMaxFrac  = 0.99
	maxPPPerItem = 0.09
)

// Tracker folds events into overall progress. Not goroutine-safe.
type Tracker struct {
	index, count int
	startSeen    bool
	streams      int
	streamsDone  int
	curFrac      float64
	indet        bool
	ppAdd        float64
	complete     bool
	sawDL        bool // a determinate download event was seen for this item
	trim         bool
	msg          string // item-level message (without the "Item i/n" prefix)

	highWater float64
	lastPct   float64
	lastMsg   string
	emitted   bool
}

// NewTracker returns a tracker for a single job.
func NewTracker() *Tracker {
	return &Tracker{index: 1, count: 1, streams: 1}
}

// Apply updates the tracker. changed reports whether pct or msg differ from
// the previous Apply result.
func (t *Tracker) Apply(e Event) (pct float64, msg string, changed bool) {
	switch e.Kind {
	case EvStart:
		t.resetItem()
		t.startSeen = true
		t.index = max(e.PlaylistIndex, 1)
		t.count = max(e.PlaylistCount, 1)
		t.streams = strings.Count(e.FormatID, "+") + 1
		// Indeterminate until a determinate download event or a postprocessor
		// arrives (ffmpeg section downloads report no progress at all).
		t.indet = true
		t.msg = t.waitMsg()
	case EvDownload:
		if !t.startSeen {
			if e.PlaylistIndex > 0 {
				t.index = e.PlaylistIndex
			}
			if e.PlaylistCount > 0 {
				t.count = e.PlaylistCount
			}
		}
		if e.Status == "finished" {
			if !t.sawDL {
				// Section download: nothing determinate was ever reported.
				t.indet = true
				t.msg = t.waitMsg()
				break
			}
			t.streamsDone = min(t.streamsDone+1, t.streams)
			t.curFrac = 0
			t.indet = false
			t.msg = t.dlLabel(e, false)
		} else {
			total := e.Total
			if total <= 0 {
				total = e.TotalEstimate
			}
			if total > 0 && e.Downloaded >= 0 {
				t.curFrac = min(e.Downloaded/total, 1)
				t.indet = false
				t.sawDL = true
			} else {
				t.indet = true
			}
			t.msg = t.dlLabel(e, total <= 0)
		}
	case EvPostprocess:
		if e.PPStatus == "started" {
			t.streamsDone, t.curFrac, t.indet = t.streams, 0, false
			t.ppAdd = min(t.ppAdd+ppStep, maxPPPerItem)
			t.msg = ppMessage(e.Postprocessor)
		}
	case EvOutput:
		t.complete = true
		t.indet = false
		t.msg = "Done"
	default:
		return t.lastPct, t.lastMsg, false
	}

	pct = t.overall()
	msg = t.msg
	if t.count > 1 {
		msg = fmt.Sprintf("Item %d/%d · %s", t.index, t.count, msg)
	}
	if pct != core.IndeterminateProgress {
		if pct < t.highWater {
			pct = t.highWater
		}
		t.highWater = pct
	}
	changed = !t.emitted || pct != t.lastPct || msg != t.lastMsg
	t.emitted, t.lastPct, t.lastMsg = true, pct, msg
	return pct, msg, changed
}

func (t *Tracker) resetItem() {
	t.streamsDone, t.curFrac, t.indet, t.ppAdd, t.complete = 0, 0, false, 0, false
	t.sawDL = false
}

// SetTrim tells the tracker the job downloads a section, which only changes
// the wording of the indeterminate message.
func (t *Tracker) SetTrim(on bool) { t.trim = on }

func (t *Tracker) waitMsg() string {
	if t.trim {
		return "Downloading section…"
	}
	return "Downloading…"
}

func (t *Tracker) overall() float64 {
	if t.indet && !t.complete {
		return core.IndeterminateProgress
	}
	frac := 1.0
	if !t.complete {
		frac = (float64(t.streamsDone) + t.curFrac) / float64(t.streams) * dlWeight
		frac = min(frac+t.ppAdd, itemMaxFrac)
	}
	n := max(1, t.count)
	return min((float64(t.index-1)+frac)/float64(n), 1)
}

func (t *Tracker) dlLabel(e Event, unknownTotal bool) string {
	label := "Downloading"
	if t.streams == 2 {
		if t.streamsDone == 0 {
			label += " video"
		} else {
			label += " audio"
		}
	}
	if unknownTotal {
		if e.Downloaded > 0 {
			label += " · " + formatBytes(e.Downloaded)
		}
		return label
	}
	if e.Speed > 0 {
		label += " · " + formatBytes(e.Speed) + "/s"
	}
	if e.ETA >= 0 {
		label += " · ETA " + formatETA(e.ETA)
	}
	return label
}

func ppMessage(name string) string {
	switch name {
	case "ExtractAudio":
		return "Extracting audio"
	case "Merger":
		return "Merging streams"
	case "VideoRemuxer", "FFmpegVideoRemuxer":
		return "Remuxing"
	case "ThumbnailsConvertor":
		return "Converting thumbnail"
	case "EmbedThumbnail":
		return "Embedding thumbnail"
	case "Metadata", "FFmpegMetadata":
		return "Writing metadata"
	case "ModifyChapters":
		return "Trimming"
	case "MoveFiles":
		return "Finalizing"
	}
	return name
}

func formatBytes(b float64) string {
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	i := 0
	for b >= 1024 && i < len(units)-1 {
		b /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%.0f B", b)
	}
	return fmt.Sprintf("%.1f %s", b, units[i])
}

func formatETA(sec float64) string {
	s := int(sec)
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s%3600/60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}
