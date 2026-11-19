package mediaindex_test

import (
	"testing"

	mi "toolbox/core/mediaindex"
	modvocab "toolbox/modules/mediaindex"
)

// The shipped vocabulary parses with this package's loader (V1 owns its
// content; this only guards the format between the two packages).
func TestShippedVocabularyParses(t *testing.T) {
	es, err := mi.ParseVocabulary(modvocab.Vocabulary)
	if err != nil {
		t.Fatal(err)
	}
	if len(es) == 0 {
		t.Fatal("empty vocabulary")
	}
	ids := map[string]bool{}
	cats := map[string]bool{}
	for _, c := range mi.Categories {
		cats[c] = true
	}
	for _, e := range es {
		ids[e.ID] = true
		if !cats[e.Category] {
			t.Errorf("%s: unknown category %q", e.ID, e.Category)
		}
	}
	for _, e := range es {
		if e.Parent != "" && !ids[e.Parent] {
			t.Errorf("%s: parent %q is not in the vocabulary", e.ID, e.Parent)
		}
	}
}
