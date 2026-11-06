package editstudio

import "context"

// jobModuleFor says which tool a job is filed under (SPEC.md §5.6): the Video
// Editor for plain videos (no analysed song), Edit Studio for analysis and
// text exports and for projects with an analysis.
func jobModuleFor(action Action, hasAnalysis bool) string {
	if action == ActionAnalyze || action == ActionText || hasAnalysis {
		return ModuleID
	}
	return VideoModuleID
}

// moduleForOptions looks the project up to attribute o's job; unknown
// projects stay with Edit Studio.
func (s *Service) moduleForOptions(ctx context.Context, o Options) string {
	if o.Action == ActionAnalyze || o.Action == ActionText || o.ProjectID == "" {
		return ModuleID
	}
	doc, err := s.m.Get(ctx, o.ProjectID)
	if err != nil {
		return ModuleID
	}
	return jobModuleFor(o.Action, doc.AnalysisKey != "")
}
