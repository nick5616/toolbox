//go:build darwin

package paste

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// Flag bits of CGEventFlags (the device-independent modifier mask).
const (
	cgFlagShift   = 0x00020000
	cgFlagControl = 0x00040000
	cgFlagAlt     = 0x00080000
	cgFlagCommand = 0x00100000
	modifierMask  = cgFlagShift | cgFlagControl | cgFlagAlt | cgFlagCommand

	cgEventSourceStateCombinedSession = 0 // kCGEventSourceStateCombinedSessionState
	cgHIDEventTap                     = 0 // kCGHIDEventTap
	keycodeV                          = 9
	activateIgnoringOtherApps         = 1 << 1 // NSApplicationActivateIgnoringOtherApps

	rtldNow    = 0x2
	rtldGlobal = 0x8
)

// macPlatform talks to AppKit / ApplicationServices / CoreGraphics through
// purego (no cgo). Symbols are resolved lazily on first use.
type macPlatform struct {
	once sync.Once
	err  error

	axIsProcessTrusted func() bool
	cgFlagsState       func(state int32) uint64
	cgKeyEvent         func(source uintptr, key uint16, down bool) uintptr
	cgSetFlags         func(ev uintptr, flags uint64)
	cgPost             func(tap uint32, ev uintptr)
	cfRelease          func(obj uintptr)
	axPromptKey        uintptr // value of kAXTrustedCheckOptionPrompt (a CFStringRef)
	axTrustedWithOpts  func(opts uintptr) bool

	selSharedWorkspace, selFrontmost, selPID, selRunningApp         objc.SEL
	selIsTerminated, selActivate, selDictWithObj, selNumberWithBool objc.SEL
}

func newPlatform() Platform { return &macPlatform{} }

func (m *macPlatform) load() error {
	m.once.Do(func() {
		defer func() {
			if r := recover(); r != nil {
				m.err = fmt.Errorf("loading macOS frameworks: %v", r)
			}
		}()
		open := func(p string) uintptr {
			h, err := purego.Dlopen(p, rtldNow|rtldGlobal)
			if err != nil {
				panic(err)
			}
			return h
		}
		open("/System/Library/Frameworks/AppKit.framework/AppKit")
		as := open("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
		cg := open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
		cf := open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")

		purego.RegisterLibFunc(&m.axIsProcessTrusted, as, "AXIsProcessTrusted")
		purego.RegisterLibFunc(&m.axTrustedWithOpts, as, "AXIsProcessTrustedWithOptions")
		purego.RegisterLibFunc(&m.cgFlagsState, cg, "CGEventSourceFlagsState")
		purego.RegisterLibFunc(&m.cgKeyEvent, cg, "CGEventCreateKeyboardEvent")
		purego.RegisterLibFunc(&m.cgSetFlags, cg, "CGEventSetFlags")
		purego.RegisterLibFunc(&m.cgPost, cg, "CGEventPost")
		purego.RegisterLibFunc(&m.cfRelease, cf, "CFRelease")

		// kAXTrustedCheckOptionPrompt is an exported CFStringRef variable.
		sym, err := purego.Dlsym(as, "kAXTrustedCheckOptionPrompt")
		if err != nil {
			panic(err)
		}
		m.axPromptKey = *(*uintptr)(*(*unsafe.Pointer)(unsafe.Pointer(&sym)))

		m.selSharedWorkspace = objc.RegisterName("sharedWorkspace")
		m.selFrontmost = objc.RegisterName("frontmostApplication")
		m.selPID = objc.RegisterName("processIdentifier")
		m.selRunningApp = objc.RegisterName("runningApplicationWithProcessIdentifier:")
		m.selIsTerminated = objc.RegisterName("isTerminated")
		m.selActivate = objc.RegisterName("activateWithOptions:")
		m.selDictWithObj = objc.RegisterName("dictionaryWithObject:forKey:")
		m.selNumberWithBool = objc.RegisterName("numberWithBool:")
	})
	return m.err
}

func (m *macPlatform) Foreground() (Target, bool) {
	if m.load() != nil {
		return 0, false
	}
	ws := objc.ID(objc.GetClass("NSWorkspace")).Send(m.selSharedWorkspace)
	if ws == 0 {
		return 0, false
	}
	app := ws.Send(m.selFrontmost)
	if app == 0 {
		return 0, false
	}
	pid := objc.Send[int32](app, m.selPID)
	if pid <= 0 {
		return 0, false
	}
	return Target(pid), int(pid) == os.Getpid()
}

func (m *macPlatform) runningApp(t Target) objc.ID {
	return objc.ID(objc.GetClass("NSRunningApplication")).Send(m.selRunningApp, int32(t))
}

func (m *macPlatform) Alive(t Target) bool {
	if m.load() != nil {
		return false
	}
	app := m.runningApp(t)
	return app != 0 && !objc.Send[bool](app, m.selIsTerminated)
}

func (m *macPlatform) Activate(t Target) error {
	if err := m.load(); err != nil {
		return err
	}
	app := m.runningApp(t)
	if app == 0 {
		return ErrTargetGone
	}
	if !objc.Send[bool](app, m.selActivate, uint64(activateIgnoringOtherApps)) {
		return errors.New("couldn't bring the previous app to the front")
	}
	return nil
}

func (m *macPlatform) ModifiersHeld() bool {
	if m.load() != nil {
		return false
	}
	return m.cgFlagsState(cgEventSourceStateCombinedSession)&modifierMask != 0
}

func (m *macPlatform) SendPaste() error {
	if err := m.load(); err != nil {
		return err
	}
	for _, down := range []bool{true, false} {
		ev := m.cgKeyEvent(0, keycodeV, down)
		if ev == 0 {
			return errors.New("couldn't create the paste key event")
		}
		m.cgSetFlags(ev, cgFlagCommand)
		m.cgPost(cgHIDEventTap, ev)
		m.cfRelease(ev)
	}
	return nil
}

func (m *macPlatform) Permission() string {
	if m.load() != nil {
		return Denied
	}
	if m.axIsProcessTrusted() {
		return Granted
	}
	return Denied
}

// RequestPermission shows the system Accessibility prompt via
// AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true}).
func (m *macPlatform) RequestPermission() error {
	if err := m.load(); err != nil {
		return err
	}
	yes := objc.ID(objc.GetClass("NSNumber")).Send(m.selNumberWithBool, true)
	opts := objc.ID(objc.GetClass("NSDictionary")).Send(m.selDictWithObj, yes, objc.ID(m.axPromptKey))
	m.axTrustedWithOpts(uintptr(opts))
	return nil
}
