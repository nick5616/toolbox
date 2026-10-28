package deps

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// UpscaylVersion is the pinned upscaler install: upscayl-ncnn release tag +
// Real-ESRGAN ncnn model release (SPEC §3.3).
const UpscaylVersion = "20251207-174704+models-0.2.5.0"

// UpscalerInstallModuleID is the hidden module that installs the upscaler.
const UpscalerInstallModuleID = "system-upscaler-install"

// RegisterUpscalerInstaller registers the hidden upscaler install module.
// CONTRACT STUB (foundation): WP-UP1 replaces the body with the archive v2
// installer (UpscaylArchive, SPEC §3.3).
func RegisterUpscalerInstaller(reg *core.Registry, s *Service) error {
	return reg.Register(&upscalerInstaller{svc: s})
}

type upscalerInstaller struct{ svc *Service }

func (u *upscalerInstaller) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: UpscalerInstallModuleID, Name: "Upscaler installer", Tagline: "Install or update the upscaler",
		Icon: "refresh-cw", Category: core.CategoryUtility, Status: core.StatusReady,
		Hidden: true, MaxConcurrent: 1,
	}
}

func (u *upscalerInstaller) Validate(inputs []string, _ json.RawMessage) error {
	if len(inputs) > 0 {
		return core.ValidationError("This task takes no inputs", nil)
	}
	return nil
}

func (u *upscalerInstaller) Run(_ context.Context, _ *core.JobContext) error {
	return core.NotImplemented("Upscaler install")
}
