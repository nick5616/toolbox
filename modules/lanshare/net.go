package lanshare

import (
	"context"
	"sync"

	"toolbox/core"
	"toolbox/core/lan"
)

// Net is the slice of *lan.Runtime this package uses. Tests inject a fake.
type Net interface {
	State() lan.State
	Settings() lan.Settings
	SetSettings(s lan.Settings) error
	SetReceive(mode lan.ReceiveMode) error
	Hold(key string)
	Release(key string)
	Devices() []lan.Device
	Device(fp string) (lan.Device, bool)
	Scan(ctx context.Context)
	Probe(ctx context.Context, fp string) (lan.Device, error)
	AddByAddress(ctx context.Context, host string, port int) (lan.Device, error)
	Pair(ctx context.Context, fp string) (string, error)
	Respond(promptID string, accept, always bool) error
	Forget(fp string) error
	SetAutoAccept(fp string, on bool) error
	Send(ctx context.Context, req lan.SendRequest, progress func(lan.SendProgress)) (lan.SendResult, error)
	Messages() []lan.Message
	ClearMessages()
	Activity() []lan.Activity
	AddActivity(text string)
}

var _ Net = (*lan.Runtime)(nil)

// Submitter is the slice of *core.Jobs this package uses.
type Submitter interface {
	Submit(ctx context.Context, moduleID string, inputs []string, optionsJSON string) ([]core.Job, error)
	Get(ctx context.Context, id string) (core.Job, error)
}

var _ Submitter = (*core.Jobs)(nil)

// maxHub bounds each in-memory table.
const maxHub = 64

// hub holds the in-memory things job options must never carry: PINs (the PDF
// passwordRef pattern), accepted incoming sessions and message texts waiting
// to be saved. The Module, the Receiver, the Sink and the Service are built
// separately in main.go, so they share this one table.
type hub struct {
	mu       sync.Mutex
	pins     map[string]string
	pinOrder []string
	sessions map[string]lan.IncomingSession
	messages map[string]savedMessage
	msgOrder []string
}

type savedMessage struct {
	Alias string
	Text  string
	At    int64
}

var shared = newHub()

func newHub() *hub {
	return &hub{pins: map[string]string{}, sessions: map[string]lan.IncomingSession{}, messages: map[string]savedMessage{}}
}

func (h *hub) putPIN(pin string) string {
	if pin == "" {
		return ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	ref := core.NewID()
	h.pins[ref] = pin
	h.pinOrder = append(h.pinOrder, ref)
	for len(h.pinOrder) > maxHub {
		delete(h.pins, h.pinOrder[0])
		h.pinOrder = h.pinOrder[1:]
	}
	return ref
}

func (h *hub) pin(ref string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.pins[ref]
}

func (h *hub) dropPIN(ref string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.pins, ref)
}

func (h *hub) putSession(s lan.IncomingSession) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sessions[s.ID()] = s
}

func (h *hub) hasSession(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.sessions[id]
	return ok
}

// takeSession removes and returns a session.
func (h *hub) takeSession(id string) (lan.IncomingSession, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[id]
	delete(h.sessions, id)
	return s, ok
}

func (h *hub) putMessage(m savedMessage) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	id := core.NewID()
	h.messages[id] = m
	h.msgOrder = append(h.msgOrder, id)
	for len(h.msgOrder) > maxHub {
		delete(h.messages, h.msgOrder[0])
		h.msgOrder = h.msgOrder[1:]
	}
	return id
}

func (h *hub) hasMessage(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.messages[id]
	return ok
}

func (h *hub) takeMessage(id string) (savedMessage, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m, ok := h.messages[id]
	delete(h.messages, id)
	return m, ok
}
