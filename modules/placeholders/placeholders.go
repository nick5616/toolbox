// Package placeholders registers the "coming soon" modules shown in the
// sidebar and in drop matches. Replace an entry with a real module when it
// is built.
package placeholders

import (
	"slices"

	"toolbox/core"
)

var rawPhoto = []string{".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2"}

func concat(sets ...[]string) []string { return slices.Concat(sets...) }

// Descriptors returns every placeholder.
func Descriptors() []core.Descriptor {
	return []core.Descriptor{
		{ID: "bg-remover", Name: "Background Remover", Icon: "wand-sparkles", Category: core.CategoryImage, Order: 140,
			Tagline:     "Cut subjects out of photos",
			Description: "Remove image backgrounds locally, leaving a clean transparent PNG.",
			Accepts:     core.Accepts{Extensions: core.ImageExtensions}},
		{ID: "upscaler", Name: "Upscaler", Icon: "maximize-2", Category: core.CategoryImage, Order: 150,
			Tagline:     "Enlarge images without the blur",
			Description: "Upscale images 2× or 4× with Real-ESRGAN running on your machine.",
			Accepts:     core.Accepts{Extensions: core.ImageExtensions}},
		{ID: "exif", Name: "EXIF", Icon: "scan-search", Category: core.CategoryImage, Order: 160,
			Tagline:     "View, edit or strip photo metadata",
			Description: "Inspect camera metadata, edit fields, or strip location and personal data before sharing.",
			Accepts:     core.Accepts{Extensions: concat(core.ImageExtensions, rawPhoto)}},
		{ID: "transcribe", Name: "Transcribe", Icon: "captions", Category: core.CategoryAI, Order: 170,
			Tagline:     "Speech to text, fully offline",
			Description: "Transcribe audio and video locally with whisper.cpp, exporting text and subtitles.",
			Accepts:     core.Accepts{Extensions: concat(core.AudioExtensions, core.VideoExtensions)}},
		{ID: "llm-chat", Name: "Local Chat", Icon: "message-square", Category: core.CategoryAI, Order: 180,
			Tagline:     "Chat with local models via Ollama",
			Description: "A private chat interface for language models running on this machine."},
		{ID: "pdf", Name: "PDF Toolkit", Icon: "file-text", Category: core.CategoryDocument, Order: 190,
			Tagline:     "Merge, split and compress PDFs",
			Description: "Everyday PDF operations without uploading documents anywhere.",
			Accepts:     core.Accepts{Extensions: []string{".pdf"}}},
		{ID: "archiver", Name: "Web Archiver", Icon: "archive", Category: core.CategoryUtility, Order: 200,
			Tagline:     "Save pages and media for offline keeping",
			Description: "Archive web pages and their media into self-contained local copies."},
		{ID: "vault", Name: "Vault", Icon: "lock", Category: core.CategoryUtility, Order: 210,
			Tagline:     "Encrypt files you want kept private",
			Description: "An encrypted folder for sensitive files, unlocked only when you need it."},
		{ID: "clipboard", Name: "Clipboard History", Icon: "clipboard", Category: core.CategoryUtility, Order: 220,
			Tagline:     "Everything you copied, one hotkey away",
			Description: "A searchable clipboard history with a global hotkey popup."},
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
