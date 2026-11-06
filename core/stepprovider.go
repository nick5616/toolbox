package core

// StepProvider is implemented by a module that is a pipeline step but whose
// own Run can't carry the step's work: job-less tools (Clipboard History)
// hand the work to a hidden companion module. The step type's ID is the
// module's ID, so the catalogue lists the tool under the name the user knows.
type StepProvider interface {
	Chainable
	// StepType describes the step. ID is forced to the module's ID; ModuleID
	// names the job-capable module whose jobs do the work. Name, Icon,
	// Category and Description default to the module's descriptor.
	StepType() StepType
}
