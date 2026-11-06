//go:build darwin && cgo

package desktop

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation -framework CoreServices
#import <Foundation/Foundation.h>
#import <CoreServices/CoreServices.h>

// toolboxSystemQuit is 1 when the quit being decided comes from a log-out,
// restart or shutdown: the 'quit' Apple event carries the reason. It is read
// while AppKit runs applicationShouldTerminate:, which is when Wails asks
// ShouldQuit. A Cmd+Q or tray Quit has no such reason.
static int toolboxSystemQuit(void) {
	NSAppleEventDescriptor *ev = [[NSAppleEventManager sharedAppleEventManager] currentAppleEvent];
	if (ev == nil || [ev eventClass] != kCoreEventClass || [ev eventID] != kAEQuitApplication) return 0;
	NSAppleEventDescriptor *why = [ev attributeDescriptorForKeyword:kAEQuitReason];
	if (why == nil) return 0;
	OSType r = [why typeCodeValue];
	return r == kAELogOut || r == kAEReallyLogOut || r == kAEShowRestartDialog || r == kAEShowShutdownDialog ||
		r == kAERestart || r == kAEShutDown;
}
*/
import "C"

// osShuttingDown is true while macOS is logging out, restarting or shutting
// down (the quit Apple event's reason), when quitting must never be refused.
func osShuttingDown() bool { return C.toolboxSystemQuit() != 0 }
