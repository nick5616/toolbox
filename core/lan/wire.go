package lan

import (
	"strings"
	"time"
	"unicode"
)

// Info is a LocalSend v2 device description: the multicast announcement, the
// register request/response and the "info" of a prepare-upload request.
// Decoding is tolerant (unknown fields are ignored; every field is optional).
type Info struct {
	Alias       string `json:"alias"`
	Version     string `json:"version"`
	DeviceModel string `json:"deviceModel,omitempty"`
	DeviceType  string `json:"deviceType,omitempty"`
	Fingerprint string `json:"fingerprint"`
	Port        int    `json:"port"`
	Protocol    string `json:"protocol"`
	Download    bool   `json:"download"`
	Announce    bool   `json:"announce"`
	// Toolbox is Toolbox's extension: 1 = this peer speaks the pairing API.
	Toolbox int `json:"toolbox,omitempty"`
}

// wireMeta is the optional metadata of a file (ISO-8601 timestamps).
type wireMeta struct {
	Modified string `json:"modified,omitempty"`
	Accessed string `json:"accessed,omitempty"`
}

// wireFile is one file of a prepare-upload request.
type wireFile struct {
	ID       string    `json:"id"`
	FileName string    `json:"fileName"`
	Size     int64     `json:"size"`
	FileType string    `json:"fileType"`
	SHA256   *string   `json:"sha256,omitempty"`
	Preview  *string   `json:"preview,omitempty"`
	Metadata *wireMeta `json:"metadata,omitempty"`
}

// prepareRequest is the body of POST /prepare-upload.
type prepareRequest struct {
	Info  Info                `json:"info"`
	Files map[string]wireFile `json:"files"`
}

// prepareResponse is the 200 reply to a prepare-upload.
type prepareResponse struct {
	SessionID string            `json:"sessionId"`
	Files     map[string]string `json:"files"`
}

// pairRequest and pairResponse are Toolbox's pairing extension.
type pairRequest struct {
	Alias string `json:"alias"`
	Port  int    `json:"port"`
}

type pairResponse struct {
	Alias string `json:"alias"`
}

// errorBody is the JSON body of Toolbox's refusals (LocalSend senders ignore it).
type errorBody struct {
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
}

// Refusal reasons carried in errorBody.Error.
const (
	reasonSpace = "insufficient_space"
)

func parseISO(s string) int64 {
	if s == "" {
		return 0
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

func formatISO(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// cleanAlias trims, strips control characters and caps an alias for display.
func cleanAlias(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 64 {
		s = string(r[:64])
	}
	if s == "" {
		return "Unknown device"
	}
	return s
}

// isTextOnly reports whether every file of a request is a small text/plain
// message with a preview (SPEC §4.1 step 7).
func isTextOnly(files map[string]wireFile) bool {
	if len(files) == 0 {
		return false
	}
	for _, f := range files {
		ft := strings.ToLower(strings.TrimSpace(strings.SplitN(f.FileType, ";", 2)[0]))
		if ft != "text/plain" || f.Preview == nil || *f.Preview == "" || f.Size > MaxTextBytes || len(*f.Preview) > MaxTextBytes {
			return false
		}
	}
	return true
}
