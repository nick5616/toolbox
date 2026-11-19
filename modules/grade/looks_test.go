package grade

import (
	"fmt"
	"os"
	"sync"
	"testing"

	"toolbox/core"
)

func TestLooksRoundTripNewestFirst(t *testing.T) {
	m := newModule(t, nil, nil)
	if l, err := m.Looks(); err != nil || len(l) != 0 {
		t.Fatalf("empty = %v, %v", l, err)
	}
	a := neonNoir()
	a.Name = "Alpha"
	b := neonNoir()
	b.Name = "Beta"
	b.Tier = TierAI // saved looks are always "mine"
	for _, r := range []Recipe{a, b} {
		if _, err := m.SaveLook(r); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := m.Looks()
	if len(got) != 2 || got[0].Name != "Beta" || got[1].Name != "Alpha" || got[0].Tier != TierMine {
		t.Fatalf("looks = %+v", got)
	}
	// Saving an existing name (case-insensitively) replaces it and moves it first.
	a.Name = "alpha"
	a.Seed = 99
	if _, err := m.SaveLook(a); err != nil {
		t.Fatal(err)
	}
	got, _ = m.Looks()
	if len(got) != 2 || got[0].Name != "alpha" || got[0].Seed != 99 {
		t.Fatalf("after replace = %+v", got)
	}
	if _, err := os.Stat(m.cfg.LooksFile + ".part"); err == nil {
		t.Error("left the temp file behind")
	}
}

func TestSaveLookValidates(t *testing.T) {
	m := newModule(t, nil, nil)
	if _, err := m.SaveLook(Recipe{V: 1, Name: "  ", Tier: TierMine, WildCurve: "linear"}); core.AsAppError(err) == nil {
		t.Error("an empty name was saved")
	}
	bad := neonNoir()
	bad.V = 2
	if _, err := m.SaveLook(bad); core.AsAppError(err) == nil || core.AsAppError(err).Code != core.CodeValidation {
		t.Errorf("a bad recipe: %v", err)
	}
}

func TestLooksLimit(t *testing.T) {
	m := newModule(t, nil, nil)
	r := neonNoir()
	var all []Recipe
	for i := 0; i < MaxLooks; i++ {
		r.Name = fmt.Sprintf("Look %d", i)
		all = append(all, r)
	}
	if err := m.writeLooks(all); err != nil {
		t.Fatal(err)
	}
	r.Name = "One too many"
	if _, err := m.SaveLook(r); core.AsAppError(err) == nil {
		t.Error("the 201st look was saved")
	}
	r.Name = "Look 5" // replacing doesn't grow the list
	if _, err := m.SaveLook(r); err != nil {
		t.Errorf("replacing at the limit: %v", err)
	}
}

func TestRenameAndDeleteLook(t *testing.T) {
	m := newModule(t, nil, nil)
	for _, n := range []string{"One", "Two"} {
		r := neonNoir()
		r.Name = n
		if _, err := m.SaveLook(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.RenameLook("One", "Two"); core.AsAppError(err) == nil || core.AsAppError(err).Code != core.CodeConflict {
		t.Errorf("rename onto an existing name: %v", err)
	}
	if err := m.RenameLook("Nope", "X"); core.AsAppError(err) == nil || core.AsAppError(err).Code != core.CodeNotFound {
		t.Errorf("rename a missing look: %v", err)
	}
	if err := m.RenameLook("One", "Uno"); err != nil {
		t.Fatal(err)
	}
	if err := m.RenameLook("Uno", "uno"); err != nil { // only the case changes
		t.Errorf("case-only rename: %v", err)
	}
	if err := m.DeleteLook("Two"); err != nil {
		t.Fatal(err)
	}
	if err := m.DeleteLook("Two"); err != nil {
		t.Errorf("deleting twice: %v", err)
	}
	got, _ := m.Looks()
	if len(got) != 1 || got[0].Name != "uno" {
		t.Errorf("looks = %+v", got)
	}
}

func TestDamagedLooksFileStartsFresh(t *testing.T) {
	m := newModule(t, nil, nil)
	if err := writeFile(m.cfg.LooksFile, "{not json"); err != nil {
		t.Fatal(err)
	}
	got, err := m.Looks()
	if err != nil || len(got) != 0 {
		t.Fatalf("%v, %v", got, err)
	}
	if _, err := os.Stat(m.cfg.LooksFile + ".bad"); err != nil {
		t.Error("the damaged file wasn't kept")
	}
}

func TestConcurrentSaves(t *testing.T) {
	m := newModule(t, nil, nil)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := neonNoir()
			r.Name = fmt.Sprintf("L%d", i)
			if _, err := m.SaveLook(r); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if got, _ := m.Looks(); len(got) != 12 {
		t.Errorf("%d looks after 12 concurrent saves", len(got))
	}
}
