package desktop

import "testing"

// --- vault (VA1) ---

func TestTrayLockVaultItemOnlyWhileUnlocked(t *testing.T) {
	has := func(s trayState) bool {
		for _, it := range trayModel(s) {
			if it.ID == itemLockVault {
				return true
			}
		}
		return false
	}
	if has(trayState{}) {
		t.Fatal("Lock vault shown while locked")
	}
	if !has(trayState{VaultUnlocked: true}) {
		t.Fatal("Lock vault missing while unlocked")
	}
}

// --- end vault ---
