// Package placeholders registers the "coming soon" modules shown in the
// sidebar and in drop matches. Replace an entry with a real module when it
// is built.
package placeholders

import "toolbox/core"

// Descriptors returns every placeholder. There are none right now (Local
// File Transfer became a real tool in Phase 13).
func Descriptors() []core.Descriptor {
	return []core.Descriptor{}
}

// Register adds every placeholder to reg.
func Register(reg *core.Registry) error {
	for _, d := range Descriptors() {
		if err := reg.RegisterPlaceholder(d); err != nil {
			return err
		}
	}
	return nil
}
