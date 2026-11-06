package paint

// Origins are the Lab's model origin cards (SPEC.md §1.4.3), confirmed
// against the papers, repos and model cards on 2026-11-06 (DECISIONS.md).
// The Lab never uses a text-to-image model or a model trained on artwork:
// Enhance uses Real-ESRGAN x4plus (photos), never the anime model.
func Origins() []Origin {
	return []Origin{
		{
			Model: "LaMa (big-lama)", UsedBy: "Fill eraser, Dissolve, Melt, Echo fill, Edge erode, Extend canvas (Best)",
			License:   "Apache-2.0",
			TrainedOn: "About 4.5 million scene photographs from Places-Challenge (Places2).",
			Generates: "Fills a masked area from the image around it. No prompts, no artwork, no imitation of any artist's style.",
			Source:    "https://arxiv.org/abs/2109.07161",
		},
		{
			Model: "MI-GAN (Places2)", UsedBy: "the same tools (Fast)",
			License:   "MIT (weights © 2024 Picsart AI Research)",
			TrainedOn: "Places2 scene photographs.",
			Generates: "Fills a masked area from the image around it. No prompts, no artwork.",
			Source:    "https://github.com/Picsart-AI-Research/MI-GAN",
		},
		{
			Model: "BiRefNet / IS-Net", UsedBy: "Subject stamp, Select subject",
			License:   "MIT (BiRefNet); IS-Net code Apache-2.0, weights licence not stated",
			TrainedOn: "Photo segmentation and matting datasets (DIS5K from licensed Flickr photos, DUTS, HRSOD, UHRSD, P3M-10k and others).",
			Generates: "Nothing: it outputs a mask of the subject.",
			Source:    "https://github.com/ZhengPeng7/BiRefNet",
		},
		{
			Model: "SAM 2.1 tiny", UsedBy: "Select object",
			License:   "Apache-2.0",
			TrainedOn: "SA-1B (11 million photos Meta licensed from a photo company, faces and plates blurred), SA-V (videos filmed by contracted crowdworkers, CC BY 4.0) and Meta's internal licensed video.",
			Generates: "Nothing: it outputs a mask from your clicks.",
			Source:    "https://ai.meta.com/datasets/segment-anything/",
		},
		{
			Model: "Real-ESRGAN x4plus", UsedBy: "Enhance brush, Upscale canvas",
			License:   "BSD-3-Clause",
			TrainedOn: "Photo datasets DIV2K, Flickr2K and OutdoorSceneTraining, degraded synthetically.",
			Generates: "Adds pixel-level detail when enlarging. No prompts, no artwork.",
			Source:    "https://arxiv.org/abs/2107.10833",
		},
	}
}
