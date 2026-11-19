package workspace

// Event names (registered in api/events.go).
const (
	// EventChanged carries the Info of the open workspace after it changed
	// (renamed, "Hide personal details" toggled).
	EventChanged = "workspace:changed"
	// EventSwitchRequest says a second launch asked for another workspace
	// (`toolbox --workspace X` while one runs); the UI asks "Switch to X?".
	EventSwitchRequest = "workspace:switch-request"
)

// SwitchRequest is the payload of EventSwitchRequest.
type SwitchRequest struct {
	Root string `json:"root"` // the folder (or workspace ID) that was asked for
	Name string `json:"name"` // its name when it is in the list, else ""
	ID   string `json:"id"`   // its ID when it is in the list, else ""
}
