// Package lanshare is Local File Transfer (SPEC.md Phase 13): send jobs
// ("lan-share"), receive jobs ("lan-receive", hidden), the Wails service and
// the "Send to a device" pipeline step, on top of core/lan.
package lanshare

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/lan"
)

// Module IDs.
const (
	ModuleID  = "lan-share"
	ReceiveID = "lan-receive"
)

// Module is the send module.
type Module struct {
	rt Net
}

// Receiver is the hidden receive module.
type Receiver struct {
	rt Net
}

// New builds both modules over the runtime (nil is allowed for tests that only
// describe: Run then fails).
func New(rt Net) (*Module, *Receiver) { return &Module{rt: rt}, &Receiver{rt: rt} }

// Register adds both modules.
func Register(reg *core.Registry, m *Module, r *Receiver) error {
	if err := reg.Register(m); err != nil {
		return err
	}
	return reg.Register(r)
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Local File Transfer", Icon: "arrow-left-right", Category: core.CategoryUtility,
		Tagline:     "Send files to your other computers and phones on the same Wi-Fi",
		Description: "Pair your own computers once, then drop files on them. Works with the free LocalSend apps on phones. Toolbox only listens while receiving is on.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Any: true},
		Order:       230,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	fields := map[string]string{}
	if o.Device == "" {
		fields["device"] = "Pick a device"
	}
	if len(o.Text) > lan.MaxTextBytes {
		fields["text"] = "The message is too long (64 KiB at most)"
	}
	if len(inputs) == 0 && o.Text == "" {
		fields["inputs"] = "Add files, a folder or a message to send"
	}
	for _, in := range inputs {
		if _, err := os.Stat(in); err != nil {
			fields["inputs"] = "File or folder not found: " + filepath.Base(in)
			break
		}
	}
	if len(fields) > 0 {
		msg := "Check what you're sending"
		for _, k := range []string{"device", "inputs", "text"} {
			if v, ok := fields[k]; ok {
				msg = v
				break
			}
		}
		return core.ValidationError(msg, fields)
	}
	return nil
}

// Descriptor implements core.Module.
func (r *Receiver) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ReceiveID, Name: "Received files", Icon: "arrow-down-to-line", Category: core.CategoryUtility,
		Status: core.StatusReady, Hidden: true, OutputSubdir: "Received", Immediate: true,
	}
}

// Validate implements core.Module. Inputs are always empty: the work is named
// by options (an accepted session or a message to save).
func (r *Receiver) Validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[ReceiveOptions](options)
	if err != nil {
		return err
	}
	switch {
	case (o.Session == "") == (o.Message == ""):
		return core.ValidationError("Nothing to receive", nil)
	case o.Session != "" && !shared.hasSession(o.Session):
		return core.Errorf(core.CodeNotFound, "That transfer isn't available any more")
	case o.Message != "" && !shared.hasMessage(o.Message):
		return core.Errorf(core.CodeNotFound, "That message isn't available any more")
	}
	return nil
}

// Sink turns accepted incoming sessions into receive jobs.
type Sink struct {
	jobs Submitter
	rt   Net
}

// NewSink builds the sink.
func NewSink(jobs Submitter, rt Net) *Sink { return &Sink{jobs: jobs, rt: rt} }

var _ lan.SessionSink = (*Sink)(nil)

// Accepted implements lan.SessionSink: one receive job per session. The
// session lives in memory only; the job's options carry its ID.
func (s *Sink) Accepted(sess lan.IncomingSession) error {
	opts, err := json.Marshal(ReceiveOptions{Session: sess.ID()})
	if err != nil {
		return fmt.Errorf("marshal receive options: %w", err)
	}
	shared.putSession(sess)
	if _, err := s.jobs.Submit(context.Background(), ReceiveID, nil, string(opts)); err != nil {
		shared.takeSession(sess.ID())
		return fmt.Errorf("queue receive job: %w", err)
	}
	return nil
}
