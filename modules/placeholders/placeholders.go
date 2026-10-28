// Package placeholders registers the "coming soon" modules shown in the
// sidebar and in drop matches. Replace an entry with a real module when it
// is built.
package placeholders

import "toolbox/core"

// Descriptors returns every placeholder.
func Descriptors() []core.Descriptor {
	return []core.Descriptor{
		{ID: "archiver", Name: "Web Archiver", Icon: "archive", Category: core.CategoryUtility, Order: 200,
			Tagline:     "Save pages and media for offline keeping",
			Description: "Archive web pages and their media into self-contained local copies."},
	}
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
