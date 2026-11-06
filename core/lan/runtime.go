package lan

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"toolbox/core"
)

// Tunables the tests shorten.
var (
	janitorInterval = 500 * time.Millisecond
	promptTimeout   = PromptTimeout
	sessionIdle     = 2 * time.Minute
	uploadIdle      = UploadIdleTimeout
	prepareTimeout  = 5 * time.Minute
	pinLockout      = 10 * time.Minute
	failedRetry     = 10 * time.Second
)

const maxPINFails = 5

// Runtime owns Local File Transfer: identity, settings, known devices, the
// listener's lifecycle, prompts and sessions. Safe for concurrent use. Every
// goroutine it starts stops on Close.
type Runtime struct {
	cfg Config
	id  *Identity
	now func() time.Time

	lifeMu sync.Mutex // serialises start/stop of the listener (taken before mu)

	mu         sync.Mutex
	sink       SessionSink
	settings   Settings
	devs       map[string]*Device
	holds      map[string]time.Time
	lis        *listener
	lastErr    string
	failedAt   time.Time
	session    *session
	busy       bool
	prompts    map[string]*promptEntry
	messages   []Message
	activity   []Activity
	ips        map[string]*ipState
	lastDevSig string
	verifyAt   map[string]time.Time
	closed     bool

	rootCtx    context.Context
	rootCancel context.CancelFunc
	stop       chan struct{}
	done       chan struct{} // closed when the janitor has stopped
	closeOnce  sync.Once
	scanning   atomic.Bool

	// Test hooks.
	scanTargetsFn func() []scanTarget
	ipHook        func(ip string, headerValue string) string
}

// New loads (or creates) the identity, settings and devices in cfg.Dir. It
// starts listening only when the saved mode is "always".
func New(cfg Config) (*Runtime, error) {
	if cfg.Dir == "" {
		return nil, errors.New("lan: no directory configured")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if err := os.MkdirAll(cfg.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating %s: %w", cfg.Dir, err)
	}
	r := &Runtime{
		cfg:      cfg,
		now:      cfg.Now,
		sink:     cfg.Sink,
		devs:     map[string]*Device{},
		holds:    map[string]time.Time{},
		prompts:  map[string]*promptEntry{},
		ips:      map[string]*ipState{},
		verifyAt: map[string]time.Time{},
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	r.rootCtx, r.rootCancel = context.WithCancel(context.Background())
	r.settings = r.loadSettings()
	id, err := LoadOrCreateIdentity(cfg.Dir, r.aliasLocked())
	if err != nil {
		return nil, err
	}
	r.id = id
	r.loadDevices()
	go r.janitor()
	if r.settings.Receive == ReceiveAlways {
		r.Apply()
	}
	return r, nil
}

// SetSink sets where accepted sessions go (called once at start-up, before receiving can begin).
func (r *Runtime) SetSink(s SessionSink) {
	r.mu.Lock()
	r.sink = s
	r.mu.Unlock()
}

// Close stops listening and every goroutine, rejects open prompts and cancels sessions.
func (r *Runtime) Close() error {
	r.closeOnce.Do(func() {
		r.rootCancel()
		r.mu.Lock()
		r.closed = true
		r.mu.Unlock()
		close(r.stop)
		<-r.done
		r.lifeMu.Lock()
		r.stopListenerLocked()
		r.lifeMu.Unlock()
		r.mu.Lock()
		r.saveDevicesLocked()
		r.mu.Unlock()
	})
	return nil
}

// Done is closed once the janitor has stopped (after Close).
func (r *Runtime) Done() <-chan struct{} { return r.done }

// Fingerprint is this computer's certificate fingerprint.
func (r *Runtime) Fingerprint() string { return r.id.Fingerprint }

// ---- settings ----

func (r *Runtime) settingsPath() string { return filepath.Join(r.cfg.Dir, "settings.json") }

func (r *Runtime) loadSettings() Settings {
	s := Settings{Receive: ReceiveOff, From: FromAnyone}
	if data, err := os.ReadFile(r.settingsPath()); err == nil {
		var in Settings
		if json.Unmarshal(data, &in) == nil {
			switch in.Receive {
			case ReceiveOff, ReceiveOpen, ReceiveAlways:
				s.Receive = in.Receive
			}
			if in.From == FromMine || in.From == FromAnyone {
				s.From = in.From
			}
			s.Alias = strings.TrimSpace(in.Alias)
			if len(in.PIN) <= MaxPINLen {
				s.PIN = in.PIN
			}
		}
	}
	return s
}

func (r *Runtime) saveSettingsLocked() error {
	data, err := json.MarshalIndent(r.settings, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(r.settingsPath(), data, 0o600)
}

// Settings returns the saved settings.
func (r *Runtime) Settings() Settings {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.settings
}

func (r *Runtime) hostname() string {
	var h string
	var err error
	if r.cfg.Hostname != nil {
		h, err = r.cfg.Hostname()
	} else {
		h, err = os.Hostname()
	}
	if err != nil {
		h = ""
	}
	if i := strings.IndexByte(h, '.'); i > 0 {
		h = h[:i]
	}
	h = cleanAliasOrEmpty(h)
	if h == "" {
		h = "Toolbox"
	}
	return h
}

func cleanAliasOrEmpty(s string) string {
	c := cleanAlias(s)
	if c == "Unknown device" && strings.TrimSpace(s) == "" {
		return ""
	}
	return c
}

// aliasLocked is the effective alias (r.mu need not be held when settings never change concurrently; callers hold it).
func (r *Runtime) aliasLocked() string {
	if a := strings.TrimSpace(r.settings.Alias); a != "" {
		return a
	}
	return r.hostname()
}

func (r *Runtime) alias() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.aliasLocked()
}

// SetSettings validates and saves alias, from and PIN (Receive is ignored: use SetReceive).
func (r *Runtime) SetSettings(s Settings) error {
	alias := strings.TrimSpace(strings.Map(func(c rune) rune {
		if unicode.IsControl(c) {
			return -1
		}
		return c
	}, s.Alias))
	fields := map[string]string{}
	if utf8.RuneCountInString(alias) > 64 {
		fields["alias"] = "Use 64 characters or fewer"
	}
	if s.From != FromMine && s.From != FromAnyone {
		fields["from"] = "Choose who can send"
	}
	if len(s.PIN) > MaxPINLen {
		fields["pin"] = fmt.Sprintf("Use %d characters or fewer", MaxPINLen)
	}
	if len(fields) > 0 {
		return core.ValidationError("Those settings can't be saved", fields)
	}
	r.mu.Lock()
	r.settings.Alias = alias
	r.settings.From = s.From
	r.settings.PIN = s.PIN
	err := r.saveSettingsLocked()
	r.mu.Unlock()
	if err != nil {
		return fmt.Errorf("saving settings: %w", err)
	}
	r.emitState()
	return nil
}

// SetReceive saves the receive mode and starts or stops listening.
func (r *Runtime) SetReceive(mode ReceiveMode) error {
	switch mode {
	case ReceiveOff, ReceiveOpen, ReceiveAlways:
	default:
		return core.ValidationError("Unknown receive mode", map[string]string{"mode": "Choose off, while open or always"})
	}
	r.mu.Lock()
	r.settings.Receive = mode
	err := r.saveSettingsLocked()
	r.failedAt = time.Time{}
	r.mu.Unlock()
	if err != nil {
		return fmt.Errorf("saving settings: %w", err)
	}
	r.Apply()
	r.emitState()
	return nil
}

// ---- state and events ----

// State is the current state.
func (r *Runtime) State() State {
	r.mu.Lock()
	s := State{
		Mode:        r.settings.Receive,
		Listening:   r.lis != nil,
		Alias:       r.aliasLocked(),
		Fingerprint: r.id.Fingerprint,
		ShortCode:   ShortCode(r.id.Fingerprint),
		From:        r.settings.From,
		PINSet:      r.settings.PIN != "",
		Error:       r.lastErr,
	}
	if r.lis != nil {
		s.Port = r.lis.port
	}
	r.mu.Unlock()
	s.Addresses = localAddrStrings(r.cfg.AllowLoopback)
	return s
}

func (r *Runtime) emit(name string, data any) {
	if r.cfg.Emit != nil {
		r.cfg.Emit(name, data)
	}
}

func (r *Runtime) emitState() { r.emit(EventState, r.State()) }

func (r *Runtime) deviceListLocked() []Device {
	now := r.now()
	out := make([]Device, 0, len(r.devs))
	for _, d := range r.devs {
		c := *d
		c.Online = c.LastSeen > 0 && now.Sub(time.UnixMilli(c.LastSeen)) <= OnlineWindow
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Paired != out[j].Paired {
			return out[i].Paired
		}
		ai, aj := strings.ToLower(out[i].Alias), strings.ToLower(out[j].Alias)
		if ai != aj {
			return ai < aj
		}
		return out[i].Fingerprint < out[j].Fingerprint
	})
	return out
}

// Devices lists known and nearby devices: paired first, then by alias.
func (r *Runtime) Devices() []Device {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.deviceListLocked()
}

// Device looks a device up by fingerprint (case-insensitive).
func (r *Runtime) Device(fp string) (Device, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, d := range r.deviceListLocked() {
		if d.Fingerprint == normFP(fp) {
			return d, true
		}
	}
	return Device{}, false
}

// emitDevicesIfChanged sends EventDevices when anything but LastSeen changed.
func (r *Runtime) emitDevicesIfChanged() {
	r.mu.Lock()
	list := r.deviceListLocked()
	sig := make([]Device, len(list))
	copy(sig, list)
	for i := range sig {
		sig[i].LastSeen = 0
	}
	b, _ := json.Marshal(sig)
	changed := string(b) != r.lastDevSig
	r.lastDevSig = string(b)
	r.mu.Unlock()
	if changed {
		r.emit(EventDevices, DevicesChanged{Devices: list})
	}
}

// ---- hold / apply ----

// Hold marks a window showing the tool ("open" mode); it expires after HoldTTL without renewal.
func (r *Runtime) Hold(key string) {
	r.mu.Lock()
	r.holds[key] = r.now().Add(HoldTTL)
	r.mu.Unlock()
	r.Apply()
}

// Release drops a window's hold.
func (r *Runtime) Release(key string) {
	r.mu.Lock()
	delete(r.holds, key)
	r.mu.Unlock()
	r.Apply()
}

func (r *Runtime) wantListeningLocked() bool {
	if r.closed {
		return false
	}
	switch r.settings.Receive {
	case ReceiveAlways:
		return true
	case ReceiveOpen:
		now := r.now()
		live := false
		for k, exp := range r.holds {
			if now.Before(exp) {
				live = true
			} else {
				delete(r.holds, k)
			}
		}
		return live
	}
	return false
}

// Apply starts or stops listening to match the settings and holds.
func (r *Runtime) Apply() { r.apply(true) }

func (r *Runtime) apply(force bool) {
	r.lifeMu.Lock()
	defer r.lifeMu.Unlock()
	r.mu.Lock()
	want := r.wantListeningLocked()
	has := r.lis != nil
	retryLater := !force && !r.failedAt.IsZero() && r.now().Sub(r.failedAt) < failedRetry
	r.mu.Unlock()
	switch {
	case want && !has:
		if retryLater {
			return
		}
		err := r.startListenerLocked()
		r.mu.Lock()
		if err != nil {
			r.lastErr = err.Error()
			var ae *core.AppError
			if errors.As(err, &ae) {
				r.lastErr = ae.Message
			}
			r.failedAt = r.now()
		} else {
			r.failedAt = time.Time{}
		}
		r.mu.Unlock()
		r.emitState()
	case !want && has:
		r.stopListenerLocked()
	case !want && !has:
		r.mu.Lock()
		had := r.lastErr != ""
		r.lastErr = ""
		r.failedAt = time.Time{}
		r.mu.Unlock()
		if had {
			r.emitState()
		}
	}
}

func (r *Runtime) janitor() {
	defer close(r.done)
	t := time.NewTicker(janitorInterval)
	defer t.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-t.C:
			r.tick()
		}
	}
}

func (r *Runtime) tick() {
	r.apply(false)
	now := r.now()
	r.mu.Lock()
	s := r.session
	stale := s != nil && now.Sub(s.lastActivity()) > sessionIdle
	for ip, st := range r.ips {
		if now.Sub(st.last) > 10*time.Minute && now.After(st.lockedUntil) {
			delete(r.ips, ip)
		}
	}
	for fp, d := range r.devs {
		if !d.Stored && d.LastSeen > 0 && now.Sub(time.UnixMilli(d.LastSeen)) > 10*time.Minute {
			delete(r.devs, fp)
		}
	}
	r.mu.Unlock()
	if stale {
		s.cancelWith(errSessionTimeout)
	}
	r.emitDevicesIfChanged()
}

// ---- devices ----

func (r *Runtime) devicesPath() string { return filepath.Join(r.cfg.Dir, "devices.json") }

type devicesFile struct {
	Devices []Device `json:"devices"`
}

func (r *Runtime) loadDevices() {
	data, err := os.ReadFile(r.devicesPath())
	if err != nil {
		return
	}
	var f devicesFile
	if json.Unmarshal(data, &f) != nil {
		return
	}
	sort.Slice(f.Devices, func(i, j int) bool { return f.Devices[i].LastSeen > f.Devices[j].LastSeen })
	for _, d := range f.Devices {
		if len(r.devs) >= MaxKnownDevices {
			break
		}
		d.Fingerprint = normFP(d.Fingerprint)
		if d.Fingerprint == "" || d.Fingerprint == r.id.Fingerprint {
			continue
		}
		d.Stored = true
		d.Online = false
		if !(d.Paired && d.Toolbox) {
			d.AutoAccept = false
		}
		c := d
		r.devs[d.Fingerprint] = &c
	}
}

func (r *Runtime) saveDevicesLocked() {
	var list []Device
	for _, d := range r.devs {
		if d.Stored {
			c := *d
			c.Online = false
			list = append(list, c)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Fingerprint < list[j].Fingerprint })
	if list == nil {
		list = []Device{}
	}
	data, err := json.MarshalIndent(devicesFile{Devices: list}, "", "  ")
	if err != nil {
		return
	}
	_ = writeFileAtomic(r.devicesPath(), data, 0o600)
}

// storeLocked marks a device stored, evicting the oldest unpaired one beyond MaxKnownDevices.
func (r *Runtime) storeLocked(d *Device) {
	d.Stored = true
	count := 0
	for _, o := range r.devs {
		if o.Stored {
			count++
		}
	}
	for count > MaxKnownDevices {
		var victim *Device
		for _, o := range r.devs {
			if !o.Stored || o == d || o.Paired {
				continue
			}
			if victim == nil || o.LastSeen < victim.LastSeen {
				victim = o
			}
		}
		if victim == nil {
			break
		}
		delete(r.devs, victim.Fingerprint)
		count--
	}
}

// noteDevice records a device seen on the network. verified means its
// certificate was checked (a presented client certificate or a pinned
// handshake); claims from unverified peers never move a stored device.
func (r *Runtime) noteDevice(in Info, fp, ip string, verified bool) Device {
	fp = normFP(fp)
	proto := strings.ToLower(in.Protocol)
	if proto != "http" {
		proto = "https"
	}
	port := in.Port
	if port <= 0 || port > 65535 {
		port = DefaultPort
	}
	now := r.now().UnixMilli()
	r.mu.Lock()
	d := r.devs[fp]
	if d == nil {
		d = &Device{Fingerprint: fp}
		r.devs[fp] = d
	}
	if d.Stored && !verified {
		d.LastSeen = now
		out := *d
		r.mu.Unlock()
		return out
	}
	before := *d
	d.Alias = cleanAlias(in.Alias)
	d.DeviceType = strings.TrimSpace(in.DeviceType)
	d.DeviceModel = strings.TrimSpace(in.DeviceModel)
	if in.Toolbox == 1 {
		d.Toolbox = true
	} else if !d.Paired {
		d.Toolbox = false
	}
	// Keep a better address seen recently (an IPv4 announce and an IPv6
	// link-local one arrive for the same device; the IPv4 one can be dialled).
	keepAddr := d.Address != "" && d.Address != ip && addrRank(d.Address) < addrRank(ip) &&
		now-d.LastSeen < OnlineWindow.Milliseconds()
	if !keepAddr {
		d.Address, d.Port = ip, port
	}
	d.Protocol = proto
	d.LastSeen = now
	changed := d.Stored && (before.Alias != d.Alias || before.Address != d.Address || before.Port != d.Port || before.Protocol != d.Protocol || before.Toolbox != d.Toolbox)
	if changed {
		r.saveDevicesLocked()
	}
	out := *d
	r.mu.Unlock()
	r.emitDevicesIfChanged()
	return out
}

// Forget removes a stored device (the other side isn't told).
func (r *Runtime) Forget(fp string) error {
	fp = normFP(fp)
	r.mu.Lock()
	d := r.devs[fp]
	if d == nil {
		r.mu.Unlock()
		return core.Errorf(core.CodeNotFound, "That device isn't known")
	}
	d.Stored, d.Paired, d.AutoAccept = false, false, false
	if d.LastSeen == 0 || r.now().Sub(time.UnixMilli(d.LastSeen)) > OnlineWindow {
		delete(r.devs, fp)
	}
	r.saveDevicesLocked()
	r.mu.Unlock()
	r.emitDevicesIfChanged()
	return nil
}

// SetAutoAccept turns "accept without asking" on or off for a paired Toolbox device.
func (r *Runtime) SetAutoAccept(fp string, on bool) error {
	fp = normFP(fp)
	r.mu.Lock()
	d := r.devs[fp]
	if d == nil {
		r.mu.Unlock()
		return core.Errorf(core.CodeNotFound, "That device isn't known")
	}
	if on && !(d.Paired && d.Toolbox) {
		r.mu.Unlock()
		return core.Errorf(core.CodeValidation, "Only paired Toolbox devices can be accepted without asking").
			WithHint("Pair with the device first")
	}
	d.AutoAccept = on
	r.saveDevicesLocked()
	r.mu.Unlock()
	r.emitDevicesIfChanged()
	return nil
}

// rememberSent stores a device we sent to.
func (r *Runtime) rememberSent(dev Device) {
	fp := normFP(dev.Fingerprint)
	if fp == "" {
		return
	}
	r.mu.Lock()
	d := r.devs[fp]
	if d == nil {
		c := dev
		c.Fingerprint = fp
		c.Online = false
		d = &c
		r.devs[fp] = d
	}
	d.LastSeen = r.now().UnixMilli()
	r.storeLocked(d)
	r.saveDevicesLocked()
	r.mu.Unlock()
	r.emitDevicesIfChanged()
}

// ---- messages and activity ----

// Messages lists received texts, oldest first.
func (r *Runtime) Messages() []Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Message{}, r.messages...)
}

// ClearMessages forgets received texts.
func (r *Runtime) ClearMessages() {
	r.mu.Lock()
	r.messages = nil
	r.mu.Unlock()
}

func (r *Runtime) addMessage(from Device, text string) {
	m := Message{ID: randHex(8), From: from, Text: text, At: r.now().UnixMilli()}
	r.mu.Lock()
	r.messages = append(r.messages, m)
	if len(r.messages) > MaxMessages {
		r.messages = r.messages[len(r.messages)-MaxMessages:]
	}
	r.mu.Unlock()
	r.emit(EventMessage, m)
}

// Activity lists recent activity lines, oldest first (≤ 100).
func (r *Runtime) Activity() []Activity {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Activity{}, r.activity...)
}

// AddActivity records an activity line (the sink uses it for finished receives).
func (r *Runtime) AddActivity(text string) {
	a := Activity{ID: randHex(8), Text: text, At: r.now().UnixMilli()}
	r.mu.Lock()
	r.activity = append(r.activity, a)
	if len(r.activity) > 100 {
		r.activity = r.activity[len(r.activity)-100:]
	}
	r.mu.Unlock()
	r.emit(EventActivity, a)
}

// ---- helpers ----

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("lan: crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(b)
}

// mergeCtx cancels the returned context when either parent is done.
func (r *Runtime) mergeCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	c, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(r.rootCtx, cancel)
	return c, func() { stop(); cancel() }
}

// selfInfo is how we describe ourselves to peers.
func (r *Runtime) selfInfo(announce bool) Info {
	r.mu.Lock()
	defer r.mu.Unlock()
	port := r.cfg.Port
	if port == 0 {
		port = DefaultPort
	}
	if r.lis != nil {
		port = r.lis.port
	}
	return Info{
		Alias: r.aliasLocked(), Version: ProtocolVersion, DeviceModel: DeviceModel, DeviceType: "desktop",
		Fingerprint: r.id.Fingerprint, Port: port, Protocol: "https", Download: false, Announce: announce, Toolbox: 1,
	}
}

// ipState is per-remote-IP rate limiting and PIN lockout state.
type ipState struct {
	sec         int64
	n           int
	prepares    []time.Time
	pinFails    int
	lockedUntil time.Time
	last        time.Time
}

func (r *Runtime) ipStateLocked(ip string) *ipState {
	st := r.ips[ip]
	if st == nil {
		if len(r.ips) >= 4096 {
			r.ips = map[string]*ipState{}
		}
		st = &ipState{}
		r.ips[ip] = st
	}
	st.last = r.now()
	return st
}

// allow applies the 20 requests/second per IP limit.
func (r *Runtime) allow(ip string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.ipStateLocked(ip)
	sec := r.now().Unix()
	if st.sec != sec {
		st.sec, st.n = sec, 0
	}
	st.n++
	return st.n <= 20
}

// allowPrepare applies the 10 prepare-uploads/minute per IP limit.
func (r *Runtime) allowPrepare(ip string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.ipStateLocked(ip)
	now := r.now()
	kept := st.prepares[:0]
	for _, t := range st.prepares {
		if now.Sub(t) < time.Minute {
			kept = append(kept, t)
		}
	}
	st.prepares = kept
	if len(st.prepares) >= 10 {
		return false
	}
	st.prepares = append(st.prepares, now)
	return true
}
