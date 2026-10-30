package viz

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPrune(t *testing.T) {
	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	old := nowFunc
	nowFunc = func() time.Time { return now }
	t.Cleanup(func() { nowFunc = old })

	a := NewAnalyzer(t.TempDir(), "", nil, nil)
	mk := func(name string, size int, age time.Duration) string {
		d := filepath.Join(a.cacheDir, name)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "s0.bin"), make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
		mt := now.Add(-age)
		if err := os.Chtimes(d, mt, mt); err != nil {
			t.Fatal(err)
		}
		return d
	}
	day := 24 * time.Hour
	stale := mk("stale", 10, 31*day)
	edge := mk("edge", 10, 29*day)
	fresh := mk("fresh", 10, day)
	loose := filepath.Join(a.cacheDir, "preview-x.mp4")
	if err := os.WriteFile(loose, []byte("p"), 0o644); err != nil {
		t.Fatal(err)
	}

	a.pruneTo(30*day, 1<<20)
	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }
	if exists(stale) || !exists(edge) || !exists(fresh) || !exists(loose) {
		t.Errorf("age prune: stale=%v edge=%v fresh=%v loose=%v", exists(stale), exists(edge), exists(fresh), exists(loose))
	}

	// By size: 3 folders of 100 bytes against a 250 byte cap removes only the oldest.
	oldest := mk("a-oldest", 100, 20*day)
	mid := mk("b-mid", 100, 10*day)
	newest := mk("c-newest", 100, 2*day)
	a.pruneTo(30*day, 250)
	if exists(oldest) {
		t.Error("oldest should go first")
	}
	if !exists(mid) || !exists(newest) {
		t.Error("pruned too much")
	}
	// The default Prune uses 30 days / 3 GB and keeps young folders.
	a.Prune()
	if !exists(mid) {
		t.Error("Prune removed a young folder")
	}
}
