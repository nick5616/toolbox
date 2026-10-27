package sidecar

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// TestMain doubles as three fake programs, selected by environment or by the
// executable's base name:
//
//	FAKE_SIDECAR=1   speaks the sidecar protocol (behaviour per request method,
//	                 FAKE_MODE for start-up behaviour)
//	<name>=uv        fake uv: --version, sync, cache clean
//	<name>=python    fake venv python: --selftest
func init() {
	base := strings.TrimSuffix(strings.ToLower(filepath.Base(os.Args[0])), ".exe")
	switch {
	case os.Getenv("FAKE_SIDECAR") == "1":
		fakeSidecar()
		os.Exit(0)
	case base == "uv":
		fakeUV()
		os.Exit(0)
	case base == "python":
		fakePython()
		os.Exit(0)
	}
}

func fakeUV() {
	args := os.Args[1:]
	if len(args) == 0 {
		os.Exit(2)
	}
	switch args[0] {
	case "--version":
		fmt.Println("uv 0.13.6 (abc123 2026-10-20)")
	case "sync":
		fmt.Fprintln(os.Stderr, "Resolved 68 packages in 1ms")
		if os.Getenv("FAKE_UV_FAIL") == "1" {
			fmt.Fprintln(os.Stderr, "error: Failed to download `torch`")
			fmt.Fprintln(os.Stderr, "  Caused by: network down")
			os.Exit(2)
		}
		// Record the environment the way uv would use it.
		venv := os.Getenv("UV_PROJECT_ENVIRONMENT")
		py := filepath.Join(venv, "bin", "python")
		if runtime.GOOS == "windows" {
			py = filepath.Join(venv, "Scripts", "python.exe")
		}
		_ = os.MkdirAll(filepath.Dir(py), 0o755)
		self, _ := os.Executable()
		b, err := os.ReadFile(self)
		if err != nil {
			os.Exit(3)
		}
		if err := os.WriteFile(py, b, 0o755); err != nil {
			os.Exit(3)
		}
		wd, _ := os.Getwd()
		env := fmt.Sprintf("cwd=%s\ncache=%s\npyinstall=%s\npref=%s\nlink=%s\nnoprogress=%s\nargs=%s\n",
			wd, os.Getenv("UV_CACHE_DIR"), os.Getenv("UV_PYTHON_INSTALL_DIR"), os.Getenv("UV_PYTHON_PREFERENCE"),
			os.Getenv("UV_LINK_MODE"), os.Getenv("UV_NO_PROGRESS"), strings.Join(args, " "))
		_ = os.WriteFile(filepath.Join(wd, "uv-sync-record.txt"), []byte(env), 0o644)
		fmt.Fprintln(os.Stderr, "Prepared 68 packages in 1ms")
		fmt.Fprintln(os.Stderr, "Installed 68 packages in 1ms")
	case "cache":
		if len(args) > 1 && args[1] == "clean" {
			_ = os.MkdirAll(os.Getenv("UV_CACHE_DIR"), 0o755)
			_ = os.WriteFile(filepath.Join(os.Getenv("UV_CACHE_DIR"), "cleaned"), []byte("1"), 0o644)
			return
		}
		os.Exit(2)
	default:
		os.Exit(2)
	}
}

func fakePython() {
	for _, a := range os.Args[1:] {
		if a == "--selftest" {
			if os.Getenv("FAKE_SELFTEST_FAIL") == "1" {
				fmt.Fprintln(os.Stderr, "ImportError: no torch")
				os.Exit(1)
			}
			fmt.Println(`{"python":"3.12.16","packages":{"toolbox-sidecar":"0.2.0","torch":"2.14.1"}}`)
			return
		}
	}
	os.Exit(2)
}

type fakeOut struct {
	mu sync.Mutex
	w  io.Writer
}

func (o *fakeOut) send(v any) {
	b, _ := json.Marshal(v)
	o.raw(append(b, '\n'))
}

func (o *fakeOut) raw(b []byte) {
	o.mu.Lock()
	o.w.Write(b)
	o.mu.Unlock()
}

type fakeReq struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func fakeSidecar() {
	out := &fakeOut{w: os.Stdout}
	switch os.Getenv("FAKE_MODE") {
	case "never_ready":
		time.Sleep(time.Hour)
	case "exit_early":
		fmt.Fprintln(os.Stderr, "boom line one")
		fmt.Fprintln(os.Stderr, "boom line two")
		os.Exit(1)
	case "garbage_first":
		fmt.Fprintln(os.Stdout, "Hello from a stray print")
		fmt.Fprintln(os.Stdout, `{"unrelated":true}`)
	}
	out.send(map[string]any{"id": "", "event": "ready", "data": map[string]any{"version": "0.2.0", "python": "3.12.16", "pid": os.Getpid()}})

	var cmu sync.Mutex
	cancels := map[string]chan struct{}{}
	ignoreShutdown := os.Getenv("FAKE_MODE") == "no_shutdown"

	sc := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := sc.ReadBytes('\n')
		if len(line) > 0 {
			var r fakeReq
			if json.Unmarshal(line, &r) == nil {
				switch r.Method {
				case "$shutdown":
					if !ignoreShutdown {
						os.Exit(0)
					}
				case "$cancel":
					cmu.Lock()
					if ch, ok := cancels[r.ID]; ok {
						close(ch)
						delete(cancels, r.ID)
					}
					cmu.Unlock()
				default:
					ch := make(chan struct{})
					cmu.Lock()
					cancels[r.ID] = ch
					cmu.Unlock()
					go fakeHandle(out, r, ch)
				}
			}
		}
		if err != nil {
			os.Exit(0)
		}
	}
}

func fakeHandle(out *fakeOut, r fakeReq, cancel chan struct{}) {
	var p struct {
		Ms    int    `json:"ms"`
		N     int    `json:"n"`
		Tag   string `json:"tag"`
		Code  string `json:"code"`
		Msg   string `json:"msg"`
		Hint  string `json:"hint"`
		Bytes int    `json:"bytes"`
	}
	_ = json.Unmarshal(r.Params, &p)
	result := func(extra map[string]any) {
		m := map[string]any{"pid": os.Getpid(), "tag": p.Tag, "rssBytes": 1000}
		for k, v := range extra {
			m[k] = v
		}
		out.send(map[string]any{"id": r.ID, "result": m})
	}
	switch r.Method {
	case "system.warmup":
		out.send(map[string]any{"id": r.ID, "result": map[string]any{}})
	case "echo", "ping":
		result(map[string]any{"params": json.RawMessage(orNull(r.Params))})
	case "sleep":
		time.Sleep(time.Duration(p.Ms) * time.Millisecond)
		result(nil)
	case "events":
		for i := 1; i <= p.N; i++ {
			out.send(map[string]any{"id": r.ID, "event": "progress", "data": map[string]any{"pct": float64(i) / float64(p.N), "msg": fmt.Sprintf("step %d", i)}})
			if i%10 == 0 {
				out.send(map[string]any{"id": r.ID, "event": "log", "data": map[string]any{"line": fmt.Sprintf("log %d", i), "level": "info"}})
			}
		}
		out.send(map[string]any{"id": r.ID, "event": "output", "data": map[string]any{"path": "/tmp/out.wav"}})
		out.send(map[string]any{"id": r.ID, "event": "progress", "data": map[string]any{"pct": -1, "msg": "wrapping up"}})
		result(nil)
	case "fail":
		e := map[string]any{"code": p.Code, "message": p.Msg}
		if p.Hint != "" {
			e["hint"] = p.Hint
		}
		out.send(map[string]any{"id": r.ID, "error": e})
	case "crash":
		os.Exit(3)
	case "ignore_cancel":
		select {}
	case "wait_cancel":
		select {
		case <-cancel:
			out.send(map[string]any{"id": r.ID, "error": map[string]any{"code": "cancelled", "message": "Cancelled by request"}})
		case <-time.After(30 * time.Second):
			result(nil)
		}
	case "big":
		result(map[string]any{"rssBytes": int64(4) << 30})
	case "garbage":
		out.raw([]byte("this is not json\n"))
		out.raw([]byte("[1,2,3]\n"))
		out.raw([]byte("{\"unrelated\":true}\n"))
		out.raw([]byte("{broken\n"))
		result(nil)
	case "huge":
		pad := strings.Repeat("a", p.Bytes)
		out.raw([]byte(`{"id":"` + r.ID + `","result":{"pad":"` + pad + "\"}}\n"))
	default:
		out.send(map[string]any{"id": r.ID, "error": map[string]any{"code": "internal", "message": "unknown method " + r.Method}})
	}
}

func orNull(b json.RawMessage) []byte {
	if len(b) == 0 {
		return []byte("null")
	}
	return b
}
