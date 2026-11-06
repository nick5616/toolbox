//go:build darwin && cgo

package trash

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation
#import <Foundation/Foundation.h>
#include <string.h>
#include <stdlib.h>

// toolboxTrash moves path to the Trash (undoable from Finder). It returns 0
// on success, or 1 with a message in errbuf.
static int toolboxTrash(const char *path, char *errbuf, int n) {
	@autoreleasepool {
		NSString *p = [NSString stringWithUTF8String:path];
		if (p == nil) { strncpy(errbuf, "invalid path", n - 1); errbuf[n - 1] = 0; return 1; }
		NSURL *u = [NSURL fileURLWithPath:p];
		NSError *e = nil;
		if ([[NSFileManager defaultManager] trashItemAtURL:u resultingItemURL:nil error:&e]) return 0;
		const char *m = e ? [[e localizedDescription] UTF8String] : "the Trash refused it";
		strncpy(errbuf, m, n - 1);
		errbuf[n - 1] = 0;
		return 1;
	}
}
*/
import "C"

import (
	"errors"
	"path/filepath"
	"unsafe"
)

type platform struct{}

func (platform) Available() bool { return true }

func (platform) Trash(paths []string) []error {
	errs := make([]error, len(paths))
	for i, p := range paths {
		abs, err := filepath.Abs(p)
		if err != nil {
			errs[i] = err
			continue
		}
		cp := C.CString(abs)
		buf := (*C.char)(C.malloc(512))
		if C.toolboxTrash(cp, buf, 512) != 0 {
			errs[i] = errors.New(C.GoString(buf))
		}
		C.free(unsafe.Pointer(cp))
		C.free(unsafe.Pointer(buf))
	}
	return errs
}
