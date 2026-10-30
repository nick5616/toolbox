package viz

import "time"

// nowFunc is the clock (tests replace it).
var nowFunc = time.Now

// prune is AN2's (SPEC.md §4.3). Stub: keeps everything.
func (a *Analyzer) prune() {}
