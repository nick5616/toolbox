// Package devutils is Dev Utilities: offline developer helpers. Its only
// job is hashing files; everything else runs in the UI (SPEC.md §10).
//
// CONTRACT STUB (foundation): module.go and service.go are final; DU1
// implements impl.go (and any new files). Exported signatures are frozen.
package devutils

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// ModuleID is Dev Utilities' module ID.
const ModuleID = "dev-utils"

// Hash algorithms.
const (
	AlgoMD5    = "md5"
	AlgoSHA1   = "sha1"
	AlgoSHA256 = "sha256"
	AlgoSHA512 = "sha512"
	AlgoCRC32  = "crc32"
)

// AllAlgorithms lists the algorithms in UI order.
func AllAlgorithms() []string { return []string{AlgoMD5, AlgoSHA1, AlgoSHA256, AlgoSHA512, AlgoCRC32} }

// Job actions. "" and ActionHash are the Hash utility (a result, no files);
// the others are the pipeline steps (Phase 14) and write files.
const (
	ActionHash      = "hash"
	ActionChecksums = "checksums"
	ActionEncode    = "encode"
)

// Checksum file formats and encodings.
const (
	FormatSidecar  = "sidecar" // <name>.sha256 (sha256sum format), one file per algorithm
	FormatCSV      = "csv"     // one CSV: file, size, one column per algorithm
	EncodingBase64 = "base64"
	EncodingHex    = "hex"
)

// Options are the job's options.
type Options struct {
	Algorithms []string `json:"algorithms"` // ≥ 1 of AllAlgorithms() (hash, checksums)
	Action     string   `json:"action"`     // "" | ActionHash | ActionChecksums | ActionEncode
	Format     string   `json:"format"`     // checksums: FormatSidecar | FormatCSV
	Encoding   string   `json:"encoding"`   // encode: EncodingBase64 | EncodingHex
	Name       string   `json:"name"`       // checksums: base name of the written file(s); "" = automatic
}

// DefaultOptions: SHA-256 only.
func DefaultOptions() Options { return Options{Algorithms: []string{AlgoSHA256}} }

// HashResult is one algorithm's hex digest.
type HashResult struct {
	Algorithm string `json:"algorithm"`
	Hex       string `json:"hex"`
}

// FileHashes are one file's digests.
type FileHashes struct {
	Path   string            `json:"path"`
	Size   int64             `json:"size"`
	Hashes map[string]string `json:"hashes"` // algorithm → hex
}

// Result is the file-hash job's result.
type Result struct {
	Files []FileHashes `json:"files"`
}

// Module implements core.Module.
type Module struct{}

// Register adds the module to the registry.
func Register(reg *core.Registry) error { return reg.Register(&Module{}) }

// Descriptor implements core.Module. It accepts no extensions, so drops
// never match it; its Hash utility picks files itself.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Dev Utilities", Icon: "braces", Category: core.CategoryUtility,
		Tagline:     "JSON, Base64, hashes, UUIDs, JWTs and more",
		Description: "Offline developer helpers: JSON and YAML, Base64, URLs, hashes, UUIDs, JWTs, timestamps, colours, regex and diffs.",
		Status:      core.StatusReady,
		Order:       220, MaxInputs: 100, OutputSubdir: "Dev Utilities",
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error { return m.run(ctx, job) }
