package mediaindex

import _ "embed"

// Vocabulary is the label vocabulary (SPEC.md §3.4), passed to
// core/mediaindex through Config.Vocabulary.
//
//go:embed vocabulary.tsv
var Vocabulary []byte
