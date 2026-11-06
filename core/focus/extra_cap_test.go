package focus

import (
	"fmt"
	"testing"

	"toolbox/core"
)

func TestAllowForThisSessionIsCapped(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30)
	allow := func(i int) error {
		rule := AllowRule{Label: "App", Kind: RuleExe, Path: fmt.Sprintf(`C:\Apps\a%d\a.exe`, i), Children: true}
		if _, err := h.e.RequestWeaken(WeakenAllow, &rule); err != nil {
			return err
		}
		return h.e.ConfirmWeaken(WeakenAllow, "")
	}
	for i := 0; i < MaxExtra; i++ {
		if err := allow(i); err != nil {
			t.Fatalf("allow %d: %v", i, err)
		}
	}
	err := allow(MaxExtra)
	wantCode(t, err, core.CodeValidation)
	if n := len(h.e.State().Session.Extra); n != MaxExtra {
		t.Fatalf("extras = %d", n)
	}
}
