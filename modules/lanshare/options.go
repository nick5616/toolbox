package lanshare

// Options are a send job's options (module "lan-share").
type Options struct {
	Device string `json:"device"` // fingerprint
	Text   string `json:"text"`   // optional message, at most 64 KiB
	PinRef string `json:"pinRef"` // the PIN lives only in the service's in-memory map, never in the DB
}

// DefaultOptions returns the defaults.
func DefaultOptions() Options { return Options{} }

// StepOptions are the "Send to a device" pipeline step's options.
type StepOptions struct {
	Device      string `json:"device"`      // fingerprint of a stored device
	WaitMinutes int    `json:"waitMinutes"` // 0..1440: how long to wait for the device to be online
	Text        string `json:"text"`        // takes {vars}
}

// DefaultStepOptions returns the step defaults.
func DefaultStepOptions() StepOptions { return StepOptions{WaitMinutes: 30} }

// ReceiveOptions are a receive job's options (module "lan-receive"). Exactly
// one is set. Both refer to in-memory tables: an accepted session, or a
// received text the user chose to save.
type ReceiveOptions struct {
	Session string `json:"session"`
	Message string `json:"message"`
}

// SendJobResult is a send job's result (job.SetResult).
type SendJobResult struct {
	Device      string `json:"device"` // alias
	Fingerprint string `json:"fingerprint"`
	Files       int    `json:"files"`
	Bytes       int64  `json:"bytes"`
	AsMessage   bool   `json:"asMessage"`
}

// ReceiveJobResult is a receive job's result.
type ReceiveJobResult struct {
	From  string `json:"from"` // alias
	Files int    `json:"files"`
	Bytes int64  `json:"bytes"`
}
