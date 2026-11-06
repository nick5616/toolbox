package compress

import (
	"strconv"
	"strings"
)

// Target is a place files go, with its size limit (docs/specs/phase-17.md §3).
type Target struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Group string `json:"group"` // Chat, Email, Social, Work, Fun
	Bytes int64  `json:"bytes"`
	Note  string `json:"note"`
}

// TargetsAsOf is when the limits below were checked.
const TargetsAsOf = "2026-11"

const mb = 1_000_000

// targets is frozen data in display order. Sizes are decimal MB, which is
// conservative against services that count MiB. Email limits count the
// message's base64 encoding, so the file limit is about 73% of the stated one.
var targets = []Target{
	{ID: "discord", Label: "Discord", Group: "Chat", Bytes: 20 * mb, Note: "Free accounts (raised from 10 MB in August 2026)"},
	{ID: "discord-basic", Label: "Discord Nitro Basic", Group: "Chat", Bytes: 50 * mb},
	{ID: "discord-nitro", Label: "Discord Nitro", Group: "Chat", Bytes: 500 * mb},
	{ID: "whatsapp", Label: "WhatsApp", Group: "Chat", Bytes: 16 * mb, Note: "Sent as a video or photo; as a document it's 2 GB and uncompressed"},
	{ID: "signal", Label: "Signal", Group: "Chat", Bytes: 100 * mb},
	{ID: "imessage", Label: "iMessage", Group: "Chat", Bytes: 100 * mb},
	{ID: "telegram", Label: "Telegram", Group: "Chat", Bytes: 2000 * mb},
	{ID: "slack", Label: "Slack", Group: "Chat", Bytes: 1000 * mb},
	{ID: "mms", Label: "Text message (MMS)", Group: "Chat", Bytes: 1 * mb, Note: "Carriers vary; 1 MB is the common floor"},
	{ID: "gmail", Label: "Gmail", Group: "Email", Bytes: 18 * mb, Note: "The 25 MB limit counts the email's encoding, so the file must be about 18 MB"},
	{ID: "outlook", Label: "Outlook", Group: "Email", Bytes: 14 * mb, Note: "The 20 MB limit counts the email's encoding, so the file must be about 14 MB"},
	{ID: "icloud-mail", Label: "iCloud Mail", Group: "Email", Bytes: 14 * mb, Note: "The 20 MB limit counts the email's encoding (without Mail Drop)"},
	{ID: "bluesky-image", Label: "Bluesky photo", Group: "Social", Bytes: 2 * mb},
	{ID: "bluesky-video", Label: "Bluesky video", Group: "Social", Bytes: 300 * mb, Note: "Videos can also be at most 10 minutes"},
	{ID: "x-image", Label: "X photo", Group: "Social", Bytes: 5 * mb},
	{ID: "x-video", Label: "X video", Group: "Social", Bytes: 512 * mb},
	{ID: "mastodon-image", Label: "Mastodon photo", Group: "Social", Bytes: 16 * mb, Note: "The default; servers can change it"},
	{ID: "mastodon-video", Label: "Mastodon video", Group: "Social", Bytes: 99 * mb, Note: "The default; servers can change it"},
	{ID: "reddit-image", Label: "Reddit photo", Group: "Social", Bytes: 20 * mb},
	{ID: "github-image", Label: "GitHub image", Group: "Work", Bytes: 10 * mb, Note: "In issues, pull requests and comments"},
	{ID: "github-video", Label: "GitHub video", Group: "Work", Bytes: 10 * mb, Note: "100 MB on paid plans"},
	{ID: "github-file", Label: "GitHub file", Group: "Work", Bytes: 25 * mb},
	{ID: "floppy", Label: "Floppy disk", Group: "Fun", Bytes: 1_474_560, Note: "3½-inch, 1.44 MB"},
}

// Targets returns every target in display order (a copy).
func Targets() []Target { return append([]Target(nil), targets...) }

// TargetByID finds a target.
func TargetByID(id string) (Target, bool) {
	for _, t := range targets {
		if t.ID == id {
			return t, true
		}
	}
	return Target{}, false
}

// FormatBytes renders a size in decimal units: "850 KB", "12.4 MB", "1.5 GB".
func FormatBytes(n int64) string {
	switch {
	case n < 1000:
		return strconv.FormatInt(n, 10) + " B"
	case n < mb:
		return trimZero(float64(n)/1000, 0) + " KB"
	case n < 1000*mb:
		digits := 1
		if n >= 100*mb {
			digits = 0
		}
		return trimZero(float64(n)/mb, digits) + " MB"
	}
	return trimZero(float64(n)/(1000*mb), 2) + " GB"
}

func trimZero(v float64, digits int) string {
	s := strconv.FormatFloat(v, 'f', digits, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	return s
}
