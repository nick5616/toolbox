//go:build integration

package archiver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

// TestIntegrationMonolith archives a page served by an httptest server that
// lives only inside this test process. It needs a real monolith on PATH (or
// TOOLBOX_MONOLITH). The app itself never listens.
func TestIntegrationMonolith(t *testing.T) {
	bin := os.Getenv("TOOLBOX_MONOLITH")
	if bin == "" {
		p, err := exec.LookPath("monolith")
		if err != nil {
			t.Skip("monolith not installed")
		}
		bin = p
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head><title>Local Test Page</title><link rel="stylesheet" href="/s.css"></head><body><h1>Hi</h1></body></html>`))
	})
	mux.HandleFunc("/s.css", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/css")
		_, _ = w.Write([]byte(`h1{color:red}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r := &rec{}
	o := DefaultOptions()
	o.AllowLocal = true
	job := r.job(t, []string{srv.URL + "/"}, o)
	m := New()
	hooksJob := core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: []string{srv.URL + "/"}, Options: job.Options,
		OutputDir: job.OutputDir, TempDir: job.TempDir,
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool: func(string) (string, error) { return bin, nil },
	})
	if err := m.Validate(hooksJob.Inputs, hooksJob.Options); err != nil {
		t.Fatal(err)
	}
	if err := m.Run(context.Background(), hooksJob); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 1 {
		t.Fatalf("outputs = %v", r.outputs)
	}
	b, err := os.ReadFile(r.outputs[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "Local Test Page") || !strings.Contains(string(b), "color:red") {
		t.Errorf("page not self-contained: %.300s", b)
	}
	if !strings.HasPrefix(filepath.Base(r.outputs[0]), "Local Test Page ") {
		t.Errorf("name = %s", r.outputs[0])
	}

	// Without AllowLocal the same address is refused.
	o.AllowLocal = false
	if err := m.Validate([]string{srv.URL + "/"}, opts(o)); err == nil {
		t.Error("loopback accepted without AllowLocal")
	}
}
