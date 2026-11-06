// Package archiver is the Web Archiver: it saves a web page as one
// self-contained .html file with monolith, optionally rendering JavaScript
// first with an installed Edge/Chrome in headless mode (no debugging port),
// and optionally printing the page to PDF with the same browser.
package archiver

import (
	"context"
	"net/netip"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
)

// ModuleID is the archiver's module ID.
const ModuleID = "archiver"

// Module implements core.Module.
type Module struct {
	// browser finds an installed Edge/Chrome ("" when none).
	browser func() (path, name string)
	// lookup resolves host names for the local-address check.
	lookup func(ctx context.Context, host string) ([]netip.Addr, error)
	// now is the clock used for file names.
	now func() time.Time
}

// Register adds the Web Archiver to the registry.
func Register(reg *core.Registry) error {
	return reg.Register(New())
}

// New builds the module with the real browser finder, resolver and clock.
func New() *Module {
	return &Module{
		browser: defaultFinder().find,
		lookup:  lookupAddrs,
		now:     time.Now,
	}
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID:           ModuleID,
		Name:         "Web Archiver",
		Tagline:      "Save pages and media for offline keeping",
		Description:  "Save a web page as one self-contained HTML file, optionally rendering its JavaScript first and keeping a PDF copy.",
		Icon:         "archive",
		Category:     core.CategoryUtility,
		Status:       core.StatusReady,
		Accepts:      core.Accepts{URLs: true},
		Requires:     []string{deps.Monolith},
		OutputSubdir: "Web Archive",
		Order:        200,
		Parts:        []string{"documents"},
	}
}
