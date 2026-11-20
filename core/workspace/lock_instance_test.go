package workspace

import "testing"

func TestLockInstanceIsExclusivePerSupportDir(t *testing.T) {
	dir, other := t.TempDir(), t.TempDir()
	unlock, ok, err := LockInstance(dir)
	if err != nil || !ok {
		t.Fatalf("first lock: ok=%v err=%v", ok, err)
	}
	if _, ok2, err := LockInstance(dir); err != nil || ok2 {
		t.Fatalf("second lock on the same dir: ok=%v err=%v, want false", ok2, err)
	}
	unlockOther, okOther, err := LockInstance(other)
	if err != nil || !okOther {
		t.Fatalf("another workspace: ok=%v err=%v", okOther, err)
	}
	unlockOther()
	unlock()
	unlock() // idempotent
	again, ok3, err := LockInstance(dir)
	if err != nil || !ok3 {
		t.Fatalf("lock after unlock: ok=%v err=%v", ok3, err)
	}
	again()
}
