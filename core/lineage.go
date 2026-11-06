package core

// Output lineage (Phase 19, SPEC.md §3.3). CONTRACT STUB (Wave 0): L1
// implements LineageInputs (the default rule, table-tested) and
// recordLineage (writes through a LineageStore when the job manager has one).

// LineageInputs decides which job inputs an output was made from.
// explicit != nil wins (OutputFrom). Otherwise: with one job input, that
// input; with several, the inputs whose file stem is a prefix of the
// output's stem; when none match, every input.
func LineageInputs(outputPath string, explicit, jobInputs []string) []string {
	if explicit != nil {
		return explicit
	}
	return jobInputs
}

// recordLineage stores o's inputs. Errors are logged, never fatal: a missing
// lineage row only means "Origin unknown" in the Library.
func (m *Jobs) recordLineage(o Output, explicit, jobInputs []string) {
	_ = o
	_ = LineageInputs(o.Path, explicit, jobInputs)
}
