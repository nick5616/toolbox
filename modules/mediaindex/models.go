package mediaindex

import (
	"context"
	"os"
	"path/filepath"

	"toolbox/core"
	ix "toolbox/core/mediaindex"
)

// The pinned vision–language model (SPEC.md §3.8; pins from the Wave 0 spike,
// docs/DECISIONS.md). SigLIP 2 ViT-B/16 at 224 px, Apache-2.0, exported to
// ONNX by Immich from timm/ViT-B-16-SigLIP2. Tokenizer: Gemma BPE
// (tokenizer.json); open_clip "canonicalize" cleaning (underscores → spaces,
// ASCII punctuation removed, lowercase, whitespace collapsed), then tokens +
// <eos>(1), right-padded with <pad>(0) to 64. Images: RGB, squashed to
// 224×224 (bicubic), (x/255 − 0.5)/0.5.

// ModelPreset is the search-default component's preset.
const ModelPreset = "siglip2-b16"

const modelRepo = "https://huggingface.co/immich-app/ViT-B-16-SigLIP2__webli/resolve/5f3fc29104ebcf51e9d893af57604badd51a3ea6/"

// modelFile is one pinned file, stored at <dir>/<Path> (Path uses "/").
type modelFile struct {
	Path   string
	Bytes  int64
	SHA256 string
}

// ModelFiles are the files search.prefetch downloads.
var ModelFiles = []modelFile{
	{"visual/model.onnx", 371674292, "fee10c729875dd203d94f396ac3d664e301d39c977ef6d92e7f467a2a716f0b0"},
	{"visual/preprocess_cfg.json", 154, "d78a80d49dca4e62d17f802a685d67d821f7102844cb89f65a0bb1a5d0601f43"},
	{"textual/model.onnx", 1129435819, "fc9991b415d7d0fac7ed540e875fd08a647c8a1abba99f12542531b004c4b68f"},
	{"textual/tokenizer.json", 34362885, "220c63d496e0c14e63eb656c91e0215e926202e4c74b1f089e09f1920d779b04"},
	{"config.json", 547, "a33af509278a65855fd6b4fd8a17ed1b1e3482ff5d438c3fc43b07d4999e01b5"},
}

// URL is a file's pinned download URL.
func (f modelFile) URL() string { return modelRepo + f.Path }

// Model constants: exp(logit_scale) and logit_bias of
// google/siglip2-base-patch16-224 (identical in timm/ViT-B-16-SigLIP2).
const (
	ModelDim     = 768
	ModelScale   = 112.66890226978423
	ModelBias    = -16.771724700927734
	ModelContext = 64
)

// ModelInfo describes the pinned model for core/mediaindex.
func ModelInfo(modelsDir string) ix.Model {
	files := make([]string, 0, len(ModelFiles))
	for _, f := range ModelFiles {
		files = append(files, f.Path)
	}
	return ix.Model{
		ID: ModelPreset, Dim: ModelDim, Scale: ModelScale, Bias: ModelBias,
		Dir: filepath.Join(modelsDir, "search", ModelPreset), Files: files,
	}
}

// IndexModule is the search-default model's provider.
var _ core.ModelProvider = (*IndexModule)(nil)

// ModelPresent implements core.ModelProvider: every pinned file is there.
func (m *IndexModule) ModelPresent(preset string) bool {
	if preset != ModelPreset || m.d.ModelsDir == "" {
		return false
	}
	dir := ModelInfo(m.d.ModelsDir).Dir
	for _, f := range ModelFiles {
		fi, err := os.Stat(filepath.Join(dir, filepath.FromSlash(f.Path)))
		if err != nil || !fi.Mode().IsRegular() {
			return false
		}
	}
	return true
}

// FetchModel implements core.ModelProvider via the engine's search.prefetch.
// CONTRACT STUB (Wave 0): S1 implements it.
func (m *IndexModule) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	return core.Errorf(core.CodeNotImplemented, "The Smart search model can't be downloaded yet")
}

// RemoveModel implements core.ModelProvider.
func (m *IndexModule) RemoveModel(preset string) error {
	if preset != ModelPreset || m.d.ModelsDir == "" {
		return nil
	}
	return os.RemoveAll(ModelInfo(m.d.ModelsDir).Dir)
}
