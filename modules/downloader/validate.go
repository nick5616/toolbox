package downloader

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"toolbox/core"
)

const maxInputs = 50

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	fields := map[string]string{}

	if len(inputs) < 1 {
		fields["inputs"] = "Add at least one link"
	} else if len(inputs) > maxInputs {
		fields["inputs"] = fmt.Sprintf("At most %d links at a time", maxInputs)
	}
	for i, in := range inputs {
		if msg := validateURL(in); msg != "" {
			fields[fmt.Sprintf("inputs.%d", i)] = msg
		}
	}

	switch opts.Mode {
	case ModeAudio, ModeVideo:
	default:
		fields["mode"] = "Choose audio or video"
	}
	switch opts.AudioFormat {
	case FormatMP3, FormatWAV, FormatFLAC:
	default:
		fields["audioFormat"] = "Choose mp3, wav or flac"
	}
	switch opts.AudioQuality {
	case QualityBest, Quality320, Quality256, Quality192, Quality128:
	default:
		fields["audioQuality"] = "Choose a valid audio quality"
	}
	switch opts.MaxResolution {
	case ResBest, Res2160, Res1440, Res1080, Res720, Res480, Res360:
	default:
		fields["maxResolution"] = "Choose a valid maximum resolution"
	}

	if opts.TrimEnabled {
		validateTrim(opts, fields)
	}

	if len(fields) > 0 {
		return core.ValidationError("Check the highlighted fields", fields)
	}
	return nil
}

func validateURL(in string) string {
	u, err := url.Parse(strings.TrimSpace(in))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "Enter a valid http or https link"
	}
	return ""
}

func validateTrim(opts Options, fields map[string]string) {
	start, end := strings.TrimSpace(opts.TrimStart), strings.TrimSpace(opts.TrimEnd)
	if start == "" && end == "" {
		fields["trimStart"] = "Set a start or an end time"
		return
	}
	var s, e float64
	var sOK, eOK bool
	if start != "" {
		if v, err := ParseTimecode(start); err != nil {
			fields["trimStart"] = "Use a time like 1:05 or 1:02:03.5"
		} else {
			s, sOK = v, true
		}
	} else {
		sOK = true // start defaults to 0
	}
	if end != "" {
		if v, err := ParseTimecode(end); err != nil {
			fields["trimEnd"] = "Use a time like 1:05 or 1:02:03.5"
		} else {
			e, eOK = v, true
		}
	}
	if sOK && eOK && e <= s {
		fields["trimEnd"] = "End must be after start"
	}
}

var errTimecode = errors.New("invalid timecode")

// ParseTimecode parses SS[.fff], M:SS[.fff], MM:SS[.fff] or H:MM:SS[.fff]
// into seconds. Non-leading minutes and seconds must be two digits and < 60.
func ParseTimecode(s string) (float64, error) {
	s = strings.TrimSpace(s)
	bad := func() (float64, error) {
		return 0, fmt.Errorf("parse timecode %q: %w", s, errTimecode)
	}
	if s == "" {
		return bad()
	}
	parts := strings.Split(s, ":")
	if len(parts) > 3 {
		return bad()
	}
	total := 0.0
	for i, p := range parts {
		last := i == len(parts)-1
		leading := i == 0
		whole, frac := p, ""
		if last {
			if w, f, ok := strings.Cut(p, "."); ok {
				whole, frac = w, f
				if f == "" || !allDigits(f) {
					return bad()
				}
			}
		}
		if whole == "" || !allDigits(whole) || len(whole) > 9 {
			return bad()
		}
		if !leading && len(whole) != 2 {
			return bad()
		}
		n, _ := strconv.Atoi(whole)
		if !leading && n >= 60 {
			return bad()
		}
		total = total*60 + float64(n)
		if frac != "" {
			f, _ := strconv.ParseFloat("0."+frac, 64)
			total += f
		}
	}
	return total, nil
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
