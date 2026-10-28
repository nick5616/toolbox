// Package placeholders registers the "coming soon" modules shown in the
// sidebar and in drop matches. Replace an entry with a real module when it
// is built.
package placeholders

import "toolbox/core"

// Descriptors returns every placeholder.
func Descriptors() []core.Descriptor {
	return []core.Descriptor{
		{ID: "llm-chat", Name: "Local Chat", Icon: "message-square", Category: core.CategoryAI, Order: 180,
			Tagline:     "Chat with local models via Ollama",
			Description: "A private chat interface for language models running on this machine."},
		{ID: "archiver", Name: "Web Archiver", Icon: "archive", Category: core.CategoryUtility, Order: 200,
			Tagline:     "Save pages and media for offline keeping",
			Description: "Archive web pages and their media into self-contained local copies."},
		{ID: "vault", Name: "Vault", Icon: "lock", Category: core.CategoryUtility, Order: 210,
			Tagline:     "Encrypt files you want kept private",
			Description: "An encrypted folder for sensitive files, unlocked only when you need it."},
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
