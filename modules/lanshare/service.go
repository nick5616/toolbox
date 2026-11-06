package lanshare

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/core/lan"
)

// Service is Local File Transfer's Wails service (SPEC.md Phase 13 §5.1).
type Service struct {
	jobs Submitter
	rt   Net

	mu         sync.Mutex
	receiveDir func() string
	scanning   bool
	cancelPair context.CancelFunc
}

// NewService builds the service.
func NewService(jobs Submitter, rt Net) *Service { return &Service{jobs: jobs, rt: rt} }

// SetReceiveDir (a function, not a method, so it stays out of the bindings) tells the service where received files live (<library>/Received).
// main.go calls it once; without it Settings().ReceiveDir is empty.
func SetReceiveDir(s *Service, fn func() string) {
	s.mu.Lock()
	s.receiveDir = fn
	s.mu.Unlock()
}

// LanSettings is what the settings drawer shows (the PIN itself never leaves Go).
type LanSettings struct {
	Alias       string       `json:"alias"`
	AliasAuto   string       `json:"aliasAuto"` // the hostname-derived default
	From        lan.FromMode `json:"from"`
	PINSet      bool         `json:"pinSet"`
	ReceiveDir  string       `json:"receiveDir"` // <library>/Received
	FirewallTip string       `json:"firewallTip"`
}

// LanSettingsInput changes settings; PIN nil = unchanged, "" = clear.
type LanSettingsInput struct {
	Alias string       `json:"alias"`
	From  lan.FromMode `json:"from"`
	PIN   *string      `json:"pin"`
}

// SendInput is one send from the UI.
type SendInput struct {
	Fingerprint string   `json:"fingerprint"`
	Paths       []string `json:"paths"`
	Text        string   `json:"text"`
	PIN         string   `json:"pin"`
}

// State returns the current state.
func (s *Service) State() lan.State { return s.rt.State() }

// Devices lists devices.
func (s *Service) Devices() []lan.Device {
	d := s.rt.Devices()
	if d == nil {
		return []lan.Device{}
	}
	return d
}

// SetReceive sets the receive mode.
func (s *Service) SetReceive(mode lan.ReceiveMode) error {
	switch mode {
	case lan.ReceiveOff, lan.ReceiveOpen, lan.ReceiveAlways:
	default:
		return core.ValidationError("Choose Off, While open or Always", nil)
	}
	return s.rt.SetReceive(mode)
}

// hostAlias is the default alias: the host name without its domain.
func hostAlias() string {
	h, err := os.Hostname()
	if err != nil {
		return "Toolbox"
	}
	if i := strings.IndexByte(h, '.'); i > 0 {
		h = h[:i]
	}
	h = strings.TrimSpace(h)
	if h == "" {
		return "Toolbox"
	}
	return h
}

func firewallTip(goos string) string {
	switch goos {
	case "windows":
		return "If your other devices can't see this computer, allow Toolbox on private networks in Windows Security → Firewall."
	case "darwin":
		return "If asked, allow Toolbox to find devices on your local network."
	}
	return "If your other devices can't see this computer, allow Toolbox through your firewall on the local network."
}

// Settings returns the settings.
func (s *Service) Settings() LanSettings {
	cur := s.rt.Settings()
	from := cur.From
	if from == "" {
		from = lan.FromAnyone
	}
	s.mu.Lock()
	dir := ""
	if s.receiveDir != nil {
		dir = s.receiveDir()
	}
	s.mu.Unlock()
	return LanSettings{
		Alias: cur.Alias, AliasAuto: hostAlias(), From: from, PINSet: cur.PIN != "",
		ReceiveDir: dir, FirewallTip: firewallTip(runtime.GOOS),
	}
}

// SetSettings saves settings.
func (s *Service) SetSettings(in LanSettingsInput) (LanSettings, error) {
	alias := strings.TrimSpace(in.Alias)
	fields := map[string]string{}
	if n := utf8.RuneCountInString(alias); n > 64 {
		fields["alias"] = "Use 64 characters or fewer"
	}
	switch in.From {
	case lan.FromMine, lan.FromAnyone:
	default:
		fields["from"] = "Choose who can send"
	}
	cur := s.rt.Settings()
	pin := cur.PIN
	if in.PIN != nil {
		pin = strings.TrimSpace(*in.PIN)
		if len(pin) > lan.MaxPINLen {
			fields["pin"] = fmt.Sprintf("Use %d characters or fewer", lan.MaxPINLen)
		}
	}
	if len(fields) > 0 {
		msg := "Check the settings"
		for _, k := range []string{"alias", "from", "pin"} {
			if v, ok := fields[k]; ok {
				msg = v
				break
			}
		}
		return LanSettings{}, core.ValidationError(msg, fields)
	}
	cur.Alias, cur.From, cur.PIN = alias, in.From, pin
	if err := s.rt.SetSettings(cur); err != nil {
		return LanSettings{}, err
	}
	return s.Settings(), nil
}

// Hold keeps "While open" receiving on for a window; renew every 10 s.
func (s *Service) Hold(windowKey string) { s.rt.Hold(windowKey) }

// Release drops a window's hold.
func (s *Service) Release(windowKey string) { s.rt.Release(windowKey) }

// Scan looks for devices (results arrive as lanshare:devices). It returns at
// once; one scan runs at a time and ends after 30 s at the latest.
func (s *Service) Scan() {
	s.mu.Lock()
	if s.scanning {
		s.mu.Unlock()
		return
	}
	s.scanning = true
	s.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		defer func() {
			s.mu.Lock()
			s.scanning = false
			s.mu.Unlock()
		}()
		s.rt.Scan(ctx)
	}()
}

// AddByAddress adds a device by host and port (0 = 53317).
func (s *Service) AddByAddress(host string, port int) (lan.Device, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return lan.Device{}, core.ValidationError("Enter the device's address", map[string]string{"host": "Enter the device's address"})
	}
	if port < 0 || port > 65535 {
		return lan.Device{}, core.ValidationError("The port must be between 1 and 65535", map[string]string{"port": "Use a port from 1 to 65535"})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	d, err := s.rt.AddByAddress(ctx, host, port)
	if err != nil {
		if core.AsAppError(err).Code == core.CodeInternal {
			return lan.Device{}, core.Errorf(lan.CodeOffline, "Couldn't reach %s", host).
				WithHint("Check the address and that receiving is on at that device").WithCause(err)
		}
		return lan.Device{}, err
	}
	return d, nil
}

// Pair pairs with a nearby Toolbox device and returns the code once both sides agree.
// One pairing runs at a time.
func (s *Service) Pair(fingerprint string) (string, error) {
	if strings.TrimSpace(fingerprint) == "" {
		return "", core.ValidationError("Pick a device to pair with", nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), lan.PairTimeout+5*time.Second)
	s.mu.Lock()
	if s.cancelPair != nil {
		s.mu.Unlock()
		cancel()
		return "", core.Errorf(core.CodeConflict, "Already pairing with a device").WithHint("Finish or cancel that first")
	}
	s.cancelPair = cancel
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		s.cancelPair = nil
		s.mu.Unlock()
	}()
	code, err := s.rt.Pair(ctx, fingerprint)
	if err != nil && ctx.Err() != nil {
		return "", core.Errorf(core.CodeCancelled, "Pairing was cancelled")
	}
	return code, err
}

// CancelPair cancels a pairing in progress.
func (s *Service) CancelPair() {
	s.mu.Lock()
	cancel := s.cancelPair
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Respond answers a prompt.
func (s *Service) Respond(promptID string, accept bool, always bool) error {
	return s.rt.Respond(promptID, accept, always)
}

// Forget removes a stored device.
func (s *Service) Forget(fingerprint string) error { return s.rt.Forget(fingerprint) }

// SetAutoAccept turns "accept without asking" on or off.
func (s *Service) SetAutoAccept(fingerprint string, on bool) error {
	return s.rt.SetAutoAccept(fingerprint, on)
}

// Send queues one send job. The PIN is kept in memory under a random
// reference; the job's options (and the DB) only carry the reference.
func (s *Service) Send(in SendInput) ([]core.Job, error) {
	pin := strings.TrimSpace(in.PIN)
	if len(pin) > lan.MaxPINLen {
		return nil, core.ValidationError("The PIN is too long", map[string]string{"pin": "Use 32 characters or fewer"})
	}
	ref := shared.putPIN(pin)
	opts, err := json.Marshal(Options{Device: in.Fingerprint, Text: in.Text, PinRef: ref})
	if err != nil {
		return nil, fmt.Errorf("marshal send options: %w", err)
	}
	jobs, err := s.jobs.Submit(context.Background(), ModuleID, in.Paths, string(opts))
	if err != nil {
		shared.dropPIN(ref)
		return nil, err
	}
	return jobs, nil
}

// Messages lists received texts.
func (s *Service) Messages() []lan.Message {
	m := s.rt.Messages()
	if m == nil {
		return []lan.Message{}
	}
	return m
}

// ClearMessages forgets received texts.
func (s *Service) ClearMessages() { s.rt.ClearMessages() }

// Activity lists recent activity.
func (s *Service) Activity() []lan.Activity {
	a := s.rt.Activity()
	if a == nil {
		return []lan.Activity{}
	}
	return a
}

// SaveMessage writes a received text to <library>/Received/<device>/Message <date>.txt
// (through a short lan-receive job, so it is a library output) and returns the output.
func (s *Service) SaveMessage(id string) (core.Output, error) {
	var msg *lan.Message
	for _, m := range s.rt.Messages() {
		if m.ID == id {
			m := m
			msg = &m
			break
		}
	}
	if msg == nil {
		return core.Output{}, core.Errorf(core.CodeNotFound, "That message isn't available any more")
	}
	token := shared.putMessage(savedMessage{Alias: msg.From.Alias, Text: msg.Text, At: msg.At})
	opts, err := json.Marshal(ReceiveOptions{Message: token})
	if err != nil {
		return core.Output{}, fmt.Errorf("marshal receive options: %w", err)
	}
	jobs, err := s.jobs.Submit(context.Background(), ReceiveID, nil, string(opts))
	if err != nil {
		shared.takeMessage(token)
		return core.Output{}, err
	}
	if len(jobs) == 0 {
		return core.Output{}, core.Errorf(core.CodeInternal, "Couldn't save the message")
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		j, gerr := s.jobs.Get(context.Background(), jobs[0].ID)
		if gerr == nil {
			switch j.Status {
			case core.JobDone:
				if len(j.Outputs) == 0 {
					return core.Output{}, core.Errorf(core.CodeInternal, "Couldn't save the message")
				}
				return j.Outputs[0], nil
			case core.JobFailed, core.JobCancelled:
				return core.Output{}, core.Errorf(core.CodeToolFailed, "Couldn't save the message").WithHint(j.Error)
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return core.Output{}, core.Errorf(core.CodeToolFailed, "Saving the message took too long")
}

// StepShape exposes the step options type to the bindings.
func (s *Service) StepShape() StepOptions { return DefaultStepOptions() }
