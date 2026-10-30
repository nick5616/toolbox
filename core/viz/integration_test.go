//go:build integration

package viz

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"toolbox/core/proc"
)

func tool(t *testing.T, name string) string {
	t.Helper()
	p, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("%s not on PATH", name)
	}
	return p
}

func ff(t *testing.T, ffmpeg string, args ...string) {
	t.Helper()
	full := append([]string{"-hide_banner", "-y", "-loglevel", "error"}, args...)
	if o, err := proc.Output(context.Background(), time.Minute, ffmpeg, full...); err != nil {
		t.Fatalf("ffmpeg %v: %v\n%s", args, err, o)
	}
}

func probe(t *testing.T, ffprobe, path string, args ...string) string {
	t.Helper()
	full := append([]string{"-v", "error"}, args...)
	full = append(full, "-of", "csv=p=0", path)
	o, err := proc.Output(context.Background(), 30*time.Second, ffprobe, full...)
	if err != nil {
		t.Fatalf("ffprobe %s: %v\n%s", path, err, o)
	}
	return strings.TrimSpace(o)
}

// pixel returns the RGB of the frame's centre pixel (frame is w×h).
func pixel(t *testing.T, ffmpeg, video string, w, h int) [3]int {
	t.Helper()
	out := filepath.Join(t.TempDir(), "p.rgb")
	ff(t, ffmpeg, "-i", video, "-frames:v", "1", "-vf", "scale="+strconv.Itoa(w)+":"+strconv.Itoa(h), "-f", "rawvideo", "-pix_fmt", "rgb24", out)
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	i := ((h/2)*w + w/2) * 3
	return [3]int{int(data[i]), int(data[i+1]), int(data[i+2])}
}

// feed sends a stream to the broker as data messages and returns the render's output.
func feed(t *testing.T, plan RenderPlan, stream []byte) (RenderOutput, string) {
	t.Helper()
	h := newHarness(t)
	res := h.run(context.Background(), plan)
	st := h.em.waitStart(t)
	h.send(st.Token, startMsg(plan, "h264-sw"))
	const chunk = 4096
	seq := 0
	for off := 0; off < len(stream); off += chunk {
		end := min(off+chunk, len(stream))
		h.send(st.Token, dataMsg(seq, stream[off:end]))
		seq++
	}
	h.send(st.Token, doneMsg(plannedFrames(plan), len(stream)))
	r := wait(t, res)
	if r.err != nil {
		t.Fatal(r.err)
	}
	return r.out, h.job.TempDir
}
