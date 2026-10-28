package pdf

import (
	"crypto/rand"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"
)

// secretTTL bounds how long a password stays in memory when its job never
// succeeds (failed or cancelled jobs keep it so Retry works).
const secretTTL = 24 * time.Hour

type secret struct {
	password    string
	newPassword string
	created     time.Time
	total, done int // jobs sharing the secret; deleted once all succeeded
}

// secrets is the in-memory password store (SPEC §6.2). Nothing here is ever
// written to disk or to job options.
type secrets struct {
	mu  sync.Mutex
	m   map[string]*secret
	now func() time.Time
}

func newSecrets() *secrets { return &secrets{m: map[string]*secret{}, now: time.Now} }

// put stores a secret and returns its opaque reference.
func (s *secrets) put(password, newPassword string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.m {
		if s.now().Sub(v.created) > secretTTL {
			delete(s.m, k)
		}
	}
	ref := ulid.MustNew(ulid.Timestamp(s.now()), rand.Reader).String()
	s.m[ref] = &secret{password: password, newPassword: newPassword, created: s.now()}
	return ref
}

// get returns the secret for ref.
func (s *secrets) get(ref string) (password, newPassword string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.m[ref]
	if !ok {
		return "", "", false
	}
	return v.password, v.newPassword, true
}

// setJobs records how many jobs share ref.
func (s *secrets) setJobs(ref string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.m[ref]; ok {
		v.total = n
		if v.done >= v.total {
			delete(s.m, ref)
		}
	}
}

// jobDone is called when one job using ref succeeded; the secret is dropped
// after the last one.
func (s *secrets) jobDone(ref string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.m[ref]; ok {
		v.done++
		if v.total > 0 && v.done >= v.total {
			delete(s.m, ref)
		}
	}
}

// drop removes ref immediately.
func (s *secrets) drop(ref string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, ref)
}
