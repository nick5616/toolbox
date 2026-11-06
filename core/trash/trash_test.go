package trash

import (
	"errors"
	"testing"
)

func TestFake(t *testing.T) {
	boom := errors.New("boom")
	f := &Fake{Fail: map[string]error{"b": boom}}
	errs := f.Trash([]string{"a", "b", "c"})
	if errs[0] != nil || !errors.Is(errs[1], boom) || errs[2] != nil {
		t.Fatalf("errs = %v", errs)
	}
	if len(f.Trashed) != 2 || f.Trashed[0] != "a" || f.Trashed[1] != "c" {
		t.Fatalf("trashed = %v", f.Trashed)
	}
	if !f.Available() || (&Fake{Off: true}).Available() {
		t.Fatal("Available")
	}
}

func TestDefaultReportsPerPath(t *testing.T) {
	if got := Default().Trash(nil); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}
