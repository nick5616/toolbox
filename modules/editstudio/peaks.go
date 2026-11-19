package editstudio

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"toolbox/core"
)

// Preview audio and waveform peaks of a source (Phase 21 SPEC §B1): the
// prepare job writes audio.m4a and peaks.bin next to the edit streams.

const (
	audioFile = "audio.m4a"
	peaksFile = "peaks.bin"

	// peaksRate is the number of min/max pairs per second; one pair covers
	// peaksWindow samples of the 48 kHz mono mix.
	peaksRate   = 100
	peaksWindow = mixRate / peaksRate

	// peaksHeader is the first line of peaks.bin; the int8 pairs follow it.
	peaksHeader = `{"v":1,"rate":100,"channels":1}` + "\n"
)

// writePeaks reads s16le mono PCM and writes peaks.bin: the header line, then
// one (min, max) pair of int8 per 10 ms window, as the signed high byte of the
// window's lowest and highest sample (−127..127). A last partial window is
// written too. It returns the number of windows.
func writePeaks(r io.Reader, w io.Writer) (int, error) {
	bw := bufio.NewWriterSize(w, 64<<10)
	if _, err := bw.WriteString(peaksHeader); err != nil {
		return 0, err
	}
	br := bufio.NewReaderSize(r, 256<<10)
	var (
		buf     [2]byte
		n       int // samples in the open window
		lo, hi  int16
		windows int
	)
	flush := func() error {
		if n == 0 {
			return nil
		}
		windows++
		n = 0
		_, err := bw.Write([]byte{byte(int8(peakByte(lo))), byte(int8(peakByte(hi)))})
		return err
	}
	for {
		if _, err := io.ReadFull(br, buf[:]); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				break
			}
			return windows, err
		}
		s := int16(binary.LittleEndian.Uint16(buf[:]))
		if n == 0 {
			lo, hi = s, s
		} else {
			lo, hi = min(lo, s), max(hi, s)
		}
		n++
		if n == peaksWindow {
			if err := flush(); err != nil {
				return windows, err
			}
		}
	}
	if err := flush(); err != nil {
		return windows, err
	}
	return windows, bw.Flush()
}

// peakByte is a 16-bit sample as the int8 a peak stores (−127..127).
func peakByte(s int16) int8 { return int8(max(int(s)>>8, -127)) }

// ---- the files ----

// audioPaths are the preview audio and peaks files in a source's cache dir.
func audioPaths(dir string) (audio, peaks string) {
	return filepath.Join(dir, audioFile), filepath.Join(dir, peaksFile)
}

func nonEmptyFile(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && fi.Size() > 0
}

// AudioFor returns the preview audio and peaks files of a source if they were
// made ("" for each that wasn't).
func (m *Module) AudioFor(path string) (audio, peaks string) {
	dir, err := m.srcDir(path)
	if err != nil {
		return "", ""
	}
	audio, peaks = audioPaths(dir)
	if !nonEmptyFile(audio) {
		audio = ""
	}
	if !nonEmptyFile(peaks) {
		peaks = ""
	}
	return audio, peaks
}

// previewAudioArgs makes audio.m4a: AAC 96 kb/s, 48 kHz stereo.
func previewAudioArgs(src, out string) []string {
	return []string{
		"-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
		"-i", src, "-map", "0:a:0", "-vn", "-sn", "-dn",
		"-c:a", "aac", "-b:a", "96k", "-ar", strconv.Itoa(mixRate), "-ac", "2",
		"-movflags", "+faststart", "-f", "mp4", out,
	}
}

// peaksPCMArgs decodes a source's first audio stream to raw s16le mono 48 kHz.
func peaksPCMArgs(src, out string) []string {
	return []string{
		"-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
		"-i", src, "-map", "0:a:0", "-vn", "-sn", "-dn",
		"-ac", "1", "-ar", strconv.Itoa(mixRate), "-f", "s16le", out,
	}
}

// EnsureAudio makes (or reuses) audio.m4a and peaks.bin of a source that has
// sound. durSec (0 = unknown) only feeds the progress. Files are made under
// ".part" names and renamed, so a cancel or a failure leaves nothing that
// looks finished.
func (m *Module) EnsureAudio(ctx context.Context, job *core.JobContext, path string, durSec float64, onProgress func(float64)) (audio, peaks string, err error) {
	report := func(f float64) {
		if onProgress != nil {
			onProgress(f)
		}
	}
	dir, err := m.srcDir(path)
	if err != nil {
		return "", "", err
	}
	audio, peaks = audioPaths(dir)
	if nonEmptyFile(audio) && nonEmptyFile(peaks) {
		touchDir(dir)
		report(1)
		return audio, peaks, nil
	}
	ffmpeg, err := m.tool(job, "ffmpeg")
	if err != nil {
		return "", "", err
	}
	unlock, err := m.lockKey(ctx, audio)
	if err != nil {
		return "", "", err
	}
	defer unlock()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", core.Errorf(core.CodeInternal, "Couldn't create the cache folder").WithCause(err)
	}
	label := filepath.Base(path)

	if !nonEmptyFile(audio) {
		part := audio + ".part"
		args := previewAudioArgs(path, part)
		if err := runFFmpegProgress(ctx, ffmpeg, args, "", durSec, "Preparing "+label, func(f float64) { report(0.45 * f) }); err != nil {
			_ = os.Remove(part)
			return "", "", audioError(ctx, err)
		}
		if err := os.Rename(part, audio); err != nil {
			_ = os.Remove(part)
			return "", "", core.Errorf(core.CodeInternal, "Couldn't save the preview audio").WithCause(err)
		}
	}
	report(0.45)
	if !nonEmptyFile(peaks) {
		raw := peaks + ".pcm.part"
		defer os.Remove(raw)
		args := peaksPCMArgs(path, raw)
		if err := runFFmpegProgress(ctx, ffmpeg, args, "", durSec, "Reading the waveform of "+label, func(f float64) { report(0.45 + 0.5*f) }); err != nil {
			return "", "", audioError(ctx, err)
		}
		if err := ctx.Err(); err != nil {
			return "", "", err
		}
		if err := peaksFromFile(raw, peaks); err != nil {
			return "", "", core.Errorf(core.CodeInternal, "Couldn't save the waveform").WithCause(err)
		}
	}
	touchDir(dir)
	report(1)
	return audio, peaks, nil
}

// audioError is ctx's error on a cancel, else err.
func audioError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// peaksFromFile reduces a raw PCM file into peaks.bin (atomically).
func peaksFromFile(raw, peaks string) error {
	in, err := os.Open(raw)
	if err != nil {
		return fmt.Errorf("open pcm: %w", err)
	}
	defer in.Close()
	part := peaks + ".part"
	out, err := os.Create(part)
	if err != nil {
		return err
	}
	if _, err := writePeaks(in, out); err != nil {
		out.Close()
		_ = os.Remove(part)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(part)
		return err
	}
	if err := os.Rename(part, peaks); err != nil {
		_ = os.Remove(part)
		return err
	}
	return nil
}
