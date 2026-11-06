package focus

import "testing"

func TestLearnRulesFollowProfileEdits(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30) // makes it the last-used profile
	if err := h.e.EndFor("x"); err != nil {
		t.Fatal(err)
	}
	if err := h.e.SetLearn(true); err != nil {
		t.Fatal(err)
	}
	h.e.tickNow()
	zoom := `C:\Program Files\Zoom\zoom.exe`
	prof := h.prof
	prof.Rules = append(append([]AllowRule{}, prof.Rules...), AllowRule{Label: "Zoom", Kind: RuleExe, Path: zoom, Children: true})
	if _, err := h.e.SaveProfile(prof); err != nil {
		t.Fatal(err)
	}
	h.fp.add(5, 0, 30, zoom)
	h.e.tickNow()
	if list, _ := h.e.LearnList(); len(list) != 0 {
		t.Fatalf("an app the profile now allows was recorded: %+v", list)
	}
	if err := h.e.DeleteProfile(prof.ID); err != nil {
		t.Fatal(err)
	}
	h.fp.add(6, 0, 40, liveExe)
	h.e.tickNow()
	if list, _ := h.e.LearnList(); len(list) != 1 || list[0].Path != liveExe {
		t.Fatalf("learn after deleting the profile = %+v", list)
	}
}
