package viz

import (
	"context"

	"toolbox/core"
)

// analyze is AN2's (SPEC.md §5.1). Stub: not built yet.
func (a *Analyzer) analyze(ctx context.Context, job *core.JobContext, input string, o AnalyzeOptions) (AnalysisRef, error) {
	return AnalysisRef{}, core.Errorf(core.CodeInternal, "not built yet")
}
