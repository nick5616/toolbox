package pipelines

import (
	"encoding/json"

	"toolbox/core"
	"toolbox/modules/archiver"
	"toolbox/modules/audiocleanup"
	"toolbox/modules/bgremove"
	"toolbox/modules/converter"
	"toolbox/modules/documents"
	"toolbox/modules/downloader"
	"toolbox/modules/lyricvideo"
	"toolbox/modules/midi"
	"toolbox/modules/ocr"
	"toolbox/modules/pdf"
	"toolbox/modules/redact"
	"toolbox/modules/stems"
	"toolbox/modules/subtitles"
	"toolbox/modules/transcribe"
	"toolbox/modules/trimmer"
	"toolbox/modules/upscale"
	"toolbox/modules/vault"
	"toolbox/modules/visualizer"
)

// Step type IDs of the tools the templates use (the module IDs).
const (
	stDownloader   = downloader.ModuleID
	stTrimmer      = trimmer.ModuleID
	stSubtitles    = subtitles.ModuleID
	stAudioCleanup = audiocleanup.ModuleID
	stTranscribe   = transcribe.ModuleID
	stStems        = stems.ModuleID
	stBPMKey       = "bpm-key"
	stMIDI         = midi.ModuleID
	stLyricVideo   = lyricvideo.ModuleID
	stBGRemover    = bgremove.ModuleID
	stUpscaler     = upscale.ModuleID
	stConverter    = converter.ModuleID
	stPDF          = pdf.ModuleID
	stOCR          = ocr.ModuleID
	stVault        = vault.ModuleID
	stRedact       = redact.ModuleID
	stVisualizer   = visualizer.ModuleID
	stDocuments    = documents.ModuleID
	stArchiver     = archiver.ModuleID
)

// tstep is one template step. Its From is "" for "the previous step"
// (or "input" for the first one).
type tstep struct {
	id, typ, from string
	opts          any
	filter        core.StepFilter
	manual        bool
	autoContinue  bool
	keep          bool
	note          string
	binds         []core.StepBind
	label         string
}

func buildTemplate(id, name, icon, blurb string, packs []string, steps ...tstep) core.PipelineTemplate {
	out := make([]core.PipelineStep, len(steps))
	prev := "input"
	for i, t := range steps {
		from := t.from
		if from == "" {
			from = prev
		}
		optionsJSON := "{}"
		if !t.manual && t.opts != nil {
			b, err := json.Marshal(t.opts)
			if err != nil {
				panic("pipelines: template " + id + ": " + err.Error()) // static data
			}
			optionsJSON = string(b)
		}
		f := t.filter
		if f.Roles == nil {
			f.Roles = []string{}
		}
		if f.Kinds == nil {
			f.Kinds = []core.OutputKind{}
		}
		if f.Exts == nil {
			f.Exts = []string{}
		}
		out[i] = core.PipelineStep{
			ID: t.id, Type: t.typ, OptionsJSON: optionsJSON, From: from, Filter: f,
			Manual: t.manual, AutoContinue: t.autoContinue, Keep: t.keep, Note: t.note,
			Binds: append([]core.StepBind{}, t.binds...), Label: t.label,
		}
		prev = t.id
	}
	return core.PipelineTemplate{
		ID: id, Blurb: blurb, Icon: icon, Packs: packs,
		Pipeline: core.Pipeline{Name: name, Description: blurb, TemplateID: id, Steps: out, Params: []core.PipelineParam{}, Watch: core.WatchConfig{}},
	}
}

func roles(r ...string) core.StepFilter { return core.StepFilter{Roles: r} }

// Prompts (SPEC.md §10).
const (
	podcastPrompt = "You are writing show notes for a podcast episode. From the transcript below, write in Markdown: a one-paragraph **Summary**; **Show notes** as 5–10 bullet points; **Chapters** as a list of `[h:mm:ss] Title` using the timestamps in the transcript. Transcript:\n\n{transcript_timed}"
	lecturePrompt = "From this lecture transcript, write Markdown study notes: the key ideas as headed sections with bullet points, a short glossary of terms, then 10 **flashcards** as `Q:`/`A:` pairs. Transcript:\n\n{transcript}"
	receiptPrompt = "Read this receipt text and extract the purchase date (YYYY-MM-DD), the merchant's name, the total paid as a number, and the currency code. Text:\n\n{text}"
)

func socialClip() core.PipelineTemplate {
	dl := downloader.DefaultOptions()
	dl.Mode, dl.MaxResolution, dl.Playlist = downloader.ModeVideo, downloader.Res1080, false
	clip := trimmer.DefaultStepOptions()
	clip.Keep, clip.Mode, clip.Aspect = trimmer.KeepWhole, trimmer.ModePrecise, trimmer.AspectPortrait
	clip.CropX, clip.CropY, clip.MaxHeight = 0.5, 0.5, 1080
	sub := subtitles.DefaultStepOptions()
	sub.Model, sub.Video, sub.Style, sub.Size, sub.MaxSizeMB = "small", subtitles.VideoBurn, subtitles.StyleBoxed, "l", 50
	return buildTemplate(TplSocialClip, "Clip for social", "smartphone",
		"Download a video, pick the part you want, crop it to 9:16 and burn in subtitles.",
		[]string{"media", "speech"},
		tstep{id: "download", typ: stDownloader, opts: dl},
		tstep{id: "pick", typ: stTrimmer, manual: true, autoContinue: true, note: "Pick the part to keep, then Export"},
		tstep{id: "crop", typ: stTrimmer, opts: clip},
		tstep{id: "subtitles", typ: stSubtitles, opts: sub, keep: true},
	)
}

func podcast() core.PipelineTemplate {
	notes := DefaultChat()
	notes.Mode, notes.Prompt, notes.OutputName, notes.Format = ChatWrite, podcastPrompt, "{item} (show notes)", FormatMD
	tr := transcribe.DefaultOptions()
	tr.Model, tr.Formats = transcribe.ModelSmall, []string{transcribe.FormatTXT, transcribe.FormatSRT}
	return buildTemplate(TplPodcast, "Podcast", "mic",
		"Clean up an episode, transcribe it and write show notes with chapters.",
		[]string{"speech", "chat"},
		tstep{id: "clean", typ: stAudioCleanup, opts: audiocleanup.DefaultStepOptions(), keep: true},
		tstep{id: "transcribe", typ: stTranscribe, opts: tr, keep: true},
		tstep{id: "notes", typ: TypeChat, from: "none", opts: notes, keep: true},
	)
}

func sampling() core.PipelineTemplate {
	dl := downloader.DefaultOptions()
	dl.Mode, dl.AudioFormat = downloader.ModeAudio, downloader.FormatFLAC
	st := stems.DefaultOptions()
	st.Preset, st.Format = stems.PresetFourFast, stems.FormatFLAC
	mi := midi.DefaultOptions()
	mi.Range = midi.RangeBass
	return buildTemplate(TplSampling, "Sampling", "audio-waveform",
		"Download a song, split it into stems, find its tempo and key, name the stems with them and turn the bass into MIDI.",
		[]string{"media", "music"},
		tstep{id: "download", typ: stDownloader, opts: dl},
		tstep{id: "stems", typ: stStems, opts: st},
		tstep{id: "tempo", typ: stBPMKey, from: "download", opts: struct{}{}},
		tstep{id: "name", typ: TypeRename, from: "stems", opts: RenameStep{Template: "{name} · {bpm} BPM · {key}"}, keep: true},
		tstep{id: "bass", typ: stMIDI, from: "name", opts: mi, filter: roles("bass"), keep: true},
	)
}

func karaoke() core.PipelineTemplate {
	st := stems.DefaultOptions()
	st.Preset, st.Format = stems.PresetVocalsFast, stems.FormatFLAC
	lv := lyricvideo.DefaultStepOptions()
	lv.Audio = "instrumental"
	lv.Look.Karaoke = true
	lv.Look.Title = "{item}"
	return buildTemplate(TplKaraoke, "Karaoke", "mic-vocal",
		"Split off the vocals and make a lyric video with the instrumental and word-by-word highlighting.",
		[]string{"music"},
		tstep{id: "vocals", typ: stStems, from: "input", opts: st, keep: true},
		tstep{id: "video", typ: stLyricVideo, from: "input", opts: lv, keep: true},
	)
}

func productPhotos() core.PipelineTemplate {
	bg := bgremove.DefaultOptions()
	bg.Model, bg.Output, bg.Color, bg.Crop, bg.Padding = bgremove.ModelBalanced, bgremove.OutputColor, "#ffffff", true, 48
	up := upscale.DefaultOptions()
	up.Model, up.Scale = upscale.ModelPhoto, 2
	cv := converter.DefaultOptions()
	cv.Preset, cv.MaxHeight, cv.KeepMetadata = "webp", converter.Height1440, false
	return buildTemplate(TplProductPhotos, "Product photos", "shopping-bag",
		"Cut out the background onto white, upscale and save as web-ready WebP.",
		[]string{"image", "media"},
		tstep{id: "cutout", typ: stBGRemover, opts: bg},
		tstep{id: "upscale", typ: stUpscaler, opts: up},
		tstep{id: "webp", typ: stConverter, opts: cv, keep: true},
	)
}

func paperArchive() core.PipelineTemplate {
	toPDF := pdf.DefaultStepOptions()
	toPDF.Action, toPDF.PageSize, toPDF.Margin = pdf.ActionImagesToPDF, pdf.PageA4, pdf.MarginSmall
	small := pdf.DefaultStepOptions()
	small.Action, small.Level = pdf.ActionCompress, pdf.LevelBalanced
	scan := ocr.DefaultOptions()
	scan.PDFOutput = ocr.PDFSearchable
	return buildTemplate(TplPaperArchive, "Paper to archive", "archive",
		"Turn photos of paper into one searchable, compact PDF and file it in the Vault.",
		[]string{"documents"},
		tstep{id: "pdf", typ: stPDF, opts: toPDF},
		tstep{id: "ocr", typ: stOCR, opts: scan},
		tstep{id: "compress", typ: stPDF, opts: small},
		tstep{id: "vault", typ: stVault, opts: vault.StepOptions{Folder: "Documents"}},
	)
}

// paperToWord is "Paper to archive"'s Word branch as its own template (the
// template model has no optional steps): photos of paper → OCR text → .docx.
func paperToWord() core.PipelineTemplate {
	scan := ocr.DefaultOptions()
	scan.PDFOutput = ocr.PDFText
	word := documents.DefaultOptions()
	word.To = documents.FormatDOCX
	return buildTemplate(TplPaperToWord, "Paper to Word", "file-text",
		"Read the text from photos or scans of paper and save it as an editable Word document.",
		[]string{"documents", "docs"},
		tstep{id: "ocr", typ: stOCR, opts: scan},
		tstep{id: "word", typ: stDocuments, opts: word, filter: roles("text"), keep: true},
	)
}

func readingList() core.PipelineTemplate {
	page := archiver.DefaultOptions()
	page.AlsoPDF = false
	book := documents.DefaultOptions()
	book.To = documents.FormatEPUB
	return buildTemplate(TplReadingList, "Archive a reading list", "book-open",
		"Save every link in a text file as one self-contained page, and make an EPUB of each to read offline.",
		[]string{"docs"},
		tstep{id: "archive", typ: stArchiver, opts: page, keep: true},
		tstep{id: "epub", typ: stDocuments, opts: book, filter: roles("page"), keep: true},
	)
}

func foreignVideo() core.PipelineTemplate {
	dl := downloader.DefaultOptions()
	dl.Mode, dl.MaxResolution, dl.Playlist = downloader.ModeVideo, downloader.Res1080, false
	sub := subtitles.DefaultStepOptions()
	sub.Model, sub.TranslateToEnglish, sub.Save = "turbo", true, []string{"srt"}
	sub.Video, sub.Style = subtitles.VideoBurn, subtitles.StyleClassic
	return buildTemplate(TplForeignVideo, "Foreign-language video", "languages",
		"Download a video and burn in English subtitles translated from the original speech.",
		[]string{"media", "speech"},
		tstep{id: "download", typ: stDownloader, opts: dl},
		tstep{id: "subtitles", typ: stSubtitles, opts: sub, keep: true},
	)
}

func receipts() core.PipelineTemplate {
	scan := ocr.DefaultOptions()
	scan.ImageOutput = ocr.ImageText
	ex := DefaultChat()
	ex.Mode, ex.Prompt, ex.Temperature = ChatExtract, receiptPrompt, 0
	ex.Fields = []ChatField{
		{Name: "when", Label: "Purchase date", Type: "date"},
		{Name: "merchant", Label: "Merchant", Type: "text"},
		{Name: "total", Label: "Total", Type: "number"},
		{Name: "currency", Label: "Currency", Type: "text"},
	}
	tb := DefaultTable()
	tb.Columns = []TableColumn{
		{Header: "File", Value: "{item}"},
		{Header: "Date", Value: "{when}"},
		{Header: "Merchant", Value: "{merchant}"},
		{Header: "Total", Value: "{total}"},
		{Header: "Currency", Value: "{currency}"},
	}
	return buildTemplate(TplReceipts, "Receipts", "receipt",
		"Read receipts, pull out date, merchant and total with Local Chat, and collect them in one spreadsheet.",
		[]string{"documents", "chat"},
		tstep{id: "read", typ: stOCR, opts: scan},
		tstep{id: "extract", typ: TypeChat, from: "none", opts: ex},
		tstep{id: "table", typ: TypeTable, from: "none", opts: tb, keep: true},
	)
}

func lecture() core.PipelineTemplate {
	tr := transcribe.DefaultOptions()
	tr.Model, tr.Formats = transcribe.ModelSmall, []string{transcribe.FormatTXT, transcribe.FormatSRT}
	notes := DefaultChat()
	notes.Mode, notes.Prompt, notes.OutputName, notes.Format = ChatWrite, lecturePrompt, "{item} (study notes)", FormatMD
	return buildTemplate(TplLecture, "Lecture", "graduation-cap",
		"Transcribe a lecture and write study notes with a glossary and ten flashcards.",
		[]string{"speech", "chat"},
		tstep{id: "transcribe", typ: stTranscribe, opts: tr, keep: true},
		tstep{id: "notes", typ: TypeChat, from: "none", opts: notes, keep: true},
	)
}

func beforeSharing() core.PipelineTemplate {
	rd := redact.DefaultStepOptions()
	rd.Faces, rd.Plates, rd.Style, rd.StripMetadata = true, true, redact.StyleBlur, true
	return buildTemplate(TplBeforeSharing, "Before sharing", "shield",
		"Blur faces and licence plates, strip location data, check the result and zip it up.",
		[]string{"image"},
		tstep{id: "redact", typ: stRedact, opts: rd},
		tstep{id: "check", typ: TypeCheck, opts: struct{}{}, note: "Check every face and plate is hidden"},
		tstep{id: "zip", typ: TypeZip, opts: ZipStep{Together: true, Name: "{pipeline} {date}"}, keep: true},
	)
}

func musicVideo() core.PipelineTemplate {
	vz := visualizer.DefaultStepOptions()
	vz.PresetID, vz.ShowJSON = "golden-hour", ""
	vz.Mode, vz.Aspect, vz.Height, vz.FPS = visualizer.ModeFull, "9:16", 1080, 30
	vz.Stems, vz.Words, vz.Mood = true, "none", true
	return buildTemplate(TplMusicVideo, "Music video", "clapperboard",
		"Turn a song into a vertical music video with visuals that react to its stems and mood.",
		[]string{"music"},
		tstep{id: "video", typ: stVisualizer, opts: vz, keep: true},
	)
}
