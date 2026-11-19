package chat

import (
	"os"
	"path/filepath"
	"strings"
)

// catalogEntry is one pinned model (SPEC.md §4.2).
type catalogEntry struct {
	ID, Label string
	Repo      string // Hugging Face repo
	File      string // GGUF file name
	Bytes     int64
	SHA256    string
	License   string
	Hint      string
	IsDefault bool
	// Verified: loaded with --jinja and answered a 3-prompt check on a
	// real llama-server. Unverified models show "not tested on this machine".
	Verified bool
	// MMProj is the multimodal projector that lets the model see (Phase 20,
	// SPEC.md §5.2): downloaded, verified and removed with the model, passed
	// as --mmproj. nil = text only.
	MMProj *mmprojFile
	// VisionDefault marks the model Caption Writer installs (pack component
	// "vision-default"). Exactly one entry has it.
	VisionDefault bool
	// Hidden entries are offered only as the vision model, not in Local
	// Chat's model picker (they still work there once installed).
	Hidden bool
}

// mmprojFile is a pinned projector GGUF in the same repo as its model.
type mmprojFile struct {
	File   string
	Bytes  int64
	SHA256 string
}

// Vision reports whether the entry can read images.
func (e catalogEntry) Vision() bool { return e.MMProj != nil }

// MMProjURL is the projector's download URL ("" when text only).
func (e catalogEntry) MMProjURL() string {
	if e.MMProj == nil {
		return ""
	}
	return "https://huggingface.co/" + e.Repo + "/resolve/main/" + e.MMProj.File
}

// URL is the Hugging Face download URL.
func (e catalogEntry) URL() string {
	return "https://huggingface.co/" + e.Repo + "/resolve/main/" + e.File
}

// catalog is the frozen model list (sha256 from the Hugging Face LFS oid).
var catalog = []catalogEntry{
	{
		ID: "qwen3-4b", Label: "Qwen3 4B Instruct", Repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
		File: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", Bytes: 2497281120,
		SHA256:  "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
		License: "Apache-2.0", Hint: "Best all-rounder · needs ~4 GB free", IsDefault: true, Verified: true,
	},
	{
		ID: "qwen3.5-2b", Label: "Qwen3.5 2B", Repo: "unsloth/Qwen3.5-2B-GGUF",
		File: "Qwen3.5-2B-Q4_K_M.gguf", Bytes: 1280835840,
		SHA256:  "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
		License: "Apache-2.0", Hint: "Small and quick · ~2 GB",
		MMProj: &mmprojFile{File: "mmproj-F16.gguf", Bytes: 668227264, SHA256: "7035e9cb8d7c6a9681d07eef9a364783e86ea4cd73faab2eabb4f43a101830c7"},
	},
	{
		ID: "gemma4-e4b", Label: "Gemma 4 E4B", Repo: "unsloth/gemma-4-E4B-it-GGUF",
		File: "gemma-4-E4B-it-Q4_K_M.gguf", Bytes: 4977171584,
		SHA256:  "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
		License: "Apache-2.0", Hint: "Strongest · needs ~7 GB free (16 GB Macs+)",
		MMProj: &mmprojFile{File: "mmproj-F16.gguf", Bytes: 990372672, SHA256: "ddf46c21d7078e95338cfc22306b19b276a29a5ad089023449dd54d4b6170a51"},
	},
	{
		// Phase 20: Caption Writer's model (Wave 0 pick, docs/DECISIONS.md).
		ID: "qwen3.5-4b", Label: "Qwen3.5 4B (sees pictures)", Repo: "unsloth/Qwen3.5-4B-GGUF",
		File: "Qwen3.5-4B-Q4_K_M.gguf", Bytes: 2740937888,
		SHA256:  "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
		License: "Apache-2.0", Hint: "Reads pictures · needs ~5 GB free",
		MMProj:        &mmprojFile{File: "mmproj-F16.gguf", Bytes: 672423616, SHA256: "cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864"},
		VisionDefault: true,
	},
}

// ollamaPrefix marks Ollama model IDs ("ollama:<name>").
const ollamaPrefix = "ollama:"

func isOllamaID(id string) bool { return strings.HasPrefix(id, ollamaPrefix) }

func ollamaName(id string) string { return strings.TrimPrefix(id, ollamaPrefix) }

func (c *Chat) lookup(id string) (catalogEntry, bool) {
	for _, e := range c.entries() {
		if e.ID == id {
			return e, true
		}
	}
	return catalogEntry{}, false
}

// modelPath is where a catalog model's GGUF lives: <ModelsDir>/llm/<file>.
func (c *Chat) modelPath(e catalogEntry) string {
	return filepath.Join(c.cfg.ModelsDir, "llm", e.File)
}

// modelPresent is a cheap check: the file exists with the pinned size.
func (c *Chat) modelPresent(id string) bool {
	e, ok := c.lookup(id)
	if !ok {
		return false
	}
	fi, err := os.Stat(c.modelPath(e))
	return err == nil && fi.Mode().IsRegular() && fi.Size() == e.Bytes
}
