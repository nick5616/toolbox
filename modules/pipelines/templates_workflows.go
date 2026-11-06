package pipelines

import (
	"toolbox/core"
	"toolbox/modules/archiver"
	"toolbox/modules/audiocleanup"
	"toolbox/modules/bgremove"
	"toolbox/modules/clipboard"
	"toolbox/modules/composer"
	"toolbox/modules/converter"
	"toolbox/modules/documents"
	"toolbox/modules/downloader"
	"toolbox/modules/editstudio"
	"toolbox/modules/gif"
	"toolbox/modules/imagebatch"
	"toolbox/modules/lanshare"
	"toolbox/modules/midi"
	"toolbox/modules/organize"
	"toolbox/modules/pdf"
	"toolbox/modules/posts"
	"toolbox/modules/scenes"
	"toolbox/modules/silence"
	"toolbox/modules/stems"
	"toolbox/modules/subtitles"
	"toolbox/modules/transcribe"
	"toolbox/modules/tts"
	"toolbox/modules/vault"
	"toolbox/modules/visualizer"
)

// Step type IDs of the Phase 15 tools and the creator tools the new templates use.
const (
	stTTS          = tts.ModuleID
	stScenes       = scenes.ModuleID
	stGIF          = gif.ModuleID
	stSilence      = silence.ModuleID
	stImageBatch   = imagebatch.ModuleID
	stOrganize     = organize.ModuleID
	stClipboard    = clipboard.ModuleID
	stVideoStudio  = editstudio.VideoModuleID
	stEditStudio   = editstudio.ModuleID
	stPostBuilder  = posts.ModuleID
	stPhotoCompose = composer.ModuleID
	stLanShare     = lanshare.ModuleID
)

// Prompts of the Phase 15 templates. The variables come from the transcribe step before.
const (
	minutesPrompt = "You are writing the minutes of a meeting. From the transcript below, write in Markdown: a one-paragraph **Summary**; **Decisions** as a bullet list; **Action items** as a list of `- [ ] Task (owner, due date if mentioned)`; and **Open questions**. Only use what the transcript says; write \"not stated\" for an owner or date nobody mentioned. Transcript:\n\n{transcript_timed}"
	linkPrompt    = "Summarise this video or audio in Markdown: a one-sentence **Gist**, then **Key points** as 5–8 bullet points, then a short **Takeaway**. Transcript:\n\n{transcript}"
)

// speechLoudness evens out a spoken file's loudness and nothing else.
func speechLoudness() audiocleanup.StepOptions {
	o := audiocleanup.DefaultStepOptions()
	o.HighPass, o.Hum, o.Denoise, o.Loudness = false, audiocleanup.HumOff, audiocleanup.DenoiseOff, audiocleanup.LoudnessPodcast
	return o
}

func transcriptText() transcribe.Options {
	tr := transcribe.DefaultOptions()
	tr.Model, tr.Formats = transcribe.ModelSmall, []string{transcribe.FormatTXT}
	return tr
}

// readItToMe: a text file of links → one spoken MP3 per article. It reuses
// "Archive a reading list"'s first step and adds speech, so it is its own template.
func readItToMe() core.PipelineTemplate {
	page := archiver.DefaultOptions()
	page.AlsoPDF = false
	txt := documents.DefaultOptions()
	txt.To = documents.FormatTXT
	say := tts.DefaultStepOptions()
	return buildTemplate(TplReadItToMe, "Read it to me", "volume-2",
		"Save every link in a text file as a page, read it aloud with a local voice and even out the volume: one MP3 per article for the commute.",
		[]string{"docs", "speech"},
		tstep{id: "archive", typ: stArchiver, opts: page},
		tstep{id: "text", typ: stDocuments, opts: txt, filter: roles("page")},
		tstep{id: "speak", typ: stTTS, opts: say, filter: roles("document")},
		tstep{id: "loudness", typ: stAudioCleanup, opts: speechLoudness(), keep: true},
	)
}

// audiobook: EPUB or DOCX → Markdown → one spoken file per chapter → a zip.
func audiobook() core.PipelineTemplate {
	md := documents.DefaultOptions()
	md.To = documents.FormatMD
	say := tts.DefaultStepOptions()
	say.Split = tts.SplitHeadings
	return buildTemplate(TplAudiobook, "Audiobook from a document", "headphones",
		"Turn an EPUB or Word document into an audiobook: one spoken file per chapter, zipped together.",
		[]string{"docs", "speech"},
		tstep{id: "markdown", typ: stDocuments, opts: md},
		tstep{id: "speak", typ: stTTS, opts: say},
		tstep{id: "zip", typ: TypeZip, opts: ZipStep{Together: true, Name: "{pipeline} {date}"}, keep: true},
	)
}

// tightLecture: a recorded talk without the dead air, with subtitles, smaller.
func tightLecture() core.PipelineTemplate {
	cut := silence.DefaultStepOptions()
	cut.MinSilenceMs, cut.PaddingMs, cut.CutList = 800, 200, false
	sub := subtitles.DefaultStepOptions()
	sub.Model, sub.Video, sub.Style, sub.Size, sub.Save = "small", subtitles.VideoBurn, subtitles.StyleClassic, "m", []string{}
	small := converter.DefaultOptions()
	small.Preset, small.MaxHeight = "mp4-h264", converter.Height720
	return buildTemplate(TplTightLecture, "Tight lecture", "scissors",
		"Cut the dead air out of a recorded talk, burn in subtitles and save a smaller 720p MP4.",
		[]string{"media", "speech"},
		tstep{id: "cut", typ: stSilence, opts: cut},
		tstep{id: "subtitles", typ: stSubtitles, opts: sub, filter: roles("cut")},
		tstep{id: "small", typ: stConverter, opts: small, filter: roles("video"), keep: true},
	)
}

// podcastPolish extends the existing Podcast template with the Silence Cutter.
func podcastPolish() core.PipelineTemplate {
	cut := silence.DefaultStepOptions()
	cut.CutList = false
	notes := DefaultChat()
	notes.Mode, notes.Prompt, notes.OutputName, notes.Format = ChatWrite, podcastPrompt, "{item} (show notes)", FormatMD
	tr := transcribe.DefaultOptions()
	tr.Model, tr.Formats = transcribe.ModelSmall, []string{transcribe.FormatTXT, transcribe.FormatSRT}
	return buildTemplate(TplPodcastPolish, "Podcast polish", "audio-lines",
		"Clean up an episode, cut the dead air, transcribe it and write show notes with chapters and title ideas.",
		[]string{"media", "speech", "chat"},
		tstep{id: "clean", typ: stAudioCleanup, opts: audiocleanup.DefaultStepOptions()},
		tstep{id: "cut", typ: stSilence, opts: cut, keep: true},
		tstep{id: "transcribe", typ: stTranscribe, opts: tr, filter: roles("cut"), keep: true},
		tstep{id: "notes", typ: TypeChat, from: "none", opts: notes, keep: true},
	)
}

// cameraRoll: phone photos → folders by date with look-alikes set aside → 2048 px without location → Vault.
func cameraRoll() core.PipelineTemplate {
	org := organize.DefaultOptions()
	org.GroupBy, org.Duplicates, org.Similarity = organize.GroupDate, organize.DupSimilar, 90
	small := imagebatch.DefaultStepOptions()
	return buildTemplate(TplCameraRoll, "Camera-roll tidy", "images",
		"Sort a dump of phone photos into folders by date taken, set exact and near duplicates aside, shrink them to 2048 px without location data and file them in the Vault.",
		[]string{"image"},
		tstep{id: "organize", typ: stOrganize, opts: org, keep: true},
		tstep{id: "shrink", typ: stImageBatch, opts: small, filter: roles("file")},
		tstep{id: "vault", typ: stVault, opts: vault.StepOptions{Folder: "Camera roll"}},
	)
}

// shopShots: photos → white background → square → a Photo Composer template. The template is the user's choice.
func shopShots() core.PipelineTemplate {
	bg := bgremove.DefaultOptions()
	bg.Model, bg.Output, bg.Color, bg.Crop = bgremove.ModelBalanced, bgremove.OutputColor, "#ffffff", false
	sq := imagebatch.DefaultStepOptions()
	sq.Resize, sq.LongSide, sq.NoEnlarge, sq.Aspect, sq.Fit, sq.Background, sq.Quality = imagebatch.ResizeLongSide, 1600, false, "1:1", imagebatch.FitPad, "#ffffff", 90
	return buildTemplate(TplShopShots, "Shop-ready product shots", "store",
		"Cut the background out, make each photo a square on white and drop it into your Photo Composer template. Pick the template in the last step.",
		[]string{"image"},
		tstep{id: "cutout", typ: stBGRemover, opts: bg},
		tstep{id: "square", typ: stImageBatch, opts: sq},
		tstep{id: "fill", typ: stPhotoCompose, opts: composer.DefaultStepOptions(), keep: true, note: "Pick the template composition to fill"},
	)
}

// storyboard: a video → one still per shot as a PDF, plus a contact sheet.
func storyboard() core.PipelineTemplate {
	sc := scenes.DefaultStepOptions()
	sc.Output = scenes.OutputStills
	book := pdf.DefaultStepOptions()
	book.Action, book.PageSize, book.Margin = pdf.ActionImagesToPDF, pdf.PageA4, pdf.MarginSmall
	sheet := gif.DefaultStepOptions()
	sheet.Mode = gif.ModeSheet
	return buildTemplate(TplStoryboard, "Storyboard a video", "layout-grid",
		"Find every shot change, save one still per shot as a PDF and make a contact sheet with timecodes.",
		[]string{"media"},
		tstep{id: "shots", typ: stScenes, opts: sc},
		tstep{id: "pdf", typ: stPDF, opts: book, filter: roles("still"), keep: true},
		tstep{id: "sheet", typ: stGIF, from: "input", opts: sheet, keep: true},
	)
}

// meetingMinutes: a recording → transcript → decisions and actions → Word.
func meetingMinutes() core.PipelineTemplate {
	notes := DefaultChat()
	notes.Mode, notes.Prompt, notes.OutputName, notes.Format = ChatWrite, minutesPrompt, "{item} (minutes)", FormatMD
	notes.Temperature = 0.2
	word := documents.DefaultOptions()
	word.To = documents.FormatDOCX
	tr := transcribe.DefaultOptions()
	tr.Model, tr.Formats = transcribe.ModelSmall, []string{transcribe.FormatTXT, transcribe.FormatSRT}
	return buildTemplate(TplMeetingMinutes, "Meeting recording to minutes", "list-checks",
		"Transcribe a meeting, have Local Chat list the decisions and action items, and save the minutes as a Word document.",
		[]string{"speech", "chat", "docs"},
		tstep{id: "transcribe", typ: stTranscribe, opts: tr, keep: true},
		tstep{id: "minutes", typ: TypeChat, from: "none", opts: notes},
		tstep{id: "word", typ: stDocuments, opts: word, keep: true},
	)
}

// linkToNotes: copy a link → audio → transcript → summary → clipboard.
func linkToNotes() core.PipelineTemplate {
	dl := downloader.DefaultOptions()
	dl.Mode, dl.AudioFormat, dl.Playlist = downloader.ModeAudio, downloader.FormatMP3, false
	sum := DefaultChat()
	sum.Mode, sum.Prompt, sum.OutputName, sum.Format = ChatWrite, linkPrompt, "{item} (summary)", FormatMD
	t := buildTemplate(TplLinkToNotes, "Clipboard link to notes", "link",
		"Copy a video link and get a summary back on your clipboard: it downloads the audio, transcribes it and asks Local Chat. Turn clipboard recording on to start it by copying.",
		[]string{"media", "speech", "chat"},
		tstep{id: "download", typ: stDownloader, opts: dl},
		tstep{id: "transcribe", typ: stTranscribe, opts: transcriptText()},
		tstep{id: "summary", typ: TypeChat, from: "none", opts: sum, keep: true},
		tstep{id: "copy", typ: stClipboard, from: "summary", opts: clipboard.DefaultStepOptions()},
	)
	t.Pipeline.Clip = core.ClipTrigger{Enabled: true, Kinds: []string{core.ClipTriggerLink}}
	return t
}

// highlightReel: footage → the most active shots → cut to a song's beat. The song is the user's choice.
func highlightReel() core.PipelineTemplate {
	sc := scenes.DefaultStepOptions()
	sc.Output, sc.Keep, sc.KeepN = scenes.OutputClips, scenes.KeepActive, 12
	beat := editstudio.DefaultBeatRequest()
	beat.Aspect = "16:9"
	return buildTemplate(TplHighlightReel, "Highlight reel to the beat", "film",
		"Find the most active shots in long footage and cut them to a song's beat. Pick the song in the last step.",
		[]string{"media", "edit"},
		tstep{id: "shots", typ: stScenes, opts: sc, filter: core.StepFilter{Kinds: []core.OutputKind{core.KindVideo}}},
		tstep{id: "beat", typ: stEditStudio, opts: beat, filter: roles("scene"), keep: true, note: "Pick the song to cut to"},
	)
}

// reactionGIF: a clip with burned-in subtitles → a looping GIF.
func reactionGIF() core.PipelineTemplate {
	sub := subtitles.DefaultStepOptions()
	sub.Model, sub.Video, sub.Style, sub.Size, sub.Save = "small", subtitles.VideoBurn, subtitles.StyleBoxed, "l", []string{}
	g := gif.DefaultStepOptions()
	g.Mode, g.FPS = gif.ModeGIF, 15
	return buildTemplate(TplReactionGIF, "Reaction GIF", "sticker",
		"Burn subtitles into a short clip and turn it into a looping GIF. Set where the loop starts in the last step.",
		[]string{"media", "speech"},
		tstep{id: "subtitles", typ: stSubtitles, opts: sub},
		tstep{id: "gif", typ: stGIF, opts: g, filter: roles("video"), keep: true},
	)
}

// narratedSlideshow: photos + a script → a voice-over, and the photos → a video.
// A step reads one source, so the voice made from the script can't reach the
// slideshow step in the same run: the voice is kept in the Library, and the
// slideshow lays out the photos plus any audio file dropped with them as its
// music bed (the previous voice-over, or a recording).
func narratedSlideshow() core.PipelineTemplate {
	say := tts.DefaultStepOptions()
	show := editstudio.DefaultAssembleRequest()
	show.Aspect, show.Height, show.Fit, show.StillMs, show.Transition = "16:9", 1080, "fit-blur", 4000, "crossfade"
	show.Music = "" // wired to the voice the previous step spoke (see the bind below)
	return buildTemplate(TplNarratedSlideshow, "Narrated slideshow", "presentation",
		"Read a script aloud with a local voice and lay your photos out as a crossfading video with the voice under them. Drop the photos and a .txt or .md script.",
		[]string{"speech", "media"},
		tstep{id: "voice", typ: stTTS, from: "input", opts: say, filter: core.StepFilter{Exts: []string{".txt", ".md", ".markdown"}}, keep: true},
		tstep{id: "slideshow", typ: stVideoStudio, from: "input", opts: show, filter: core.StepFilter{Kinds: []core.OutputKind{core.KindImage}}, keep: true,
			binds: []core.StepBind{{Option: "/music", Var: "speech_file"}}},
	)
}

// songEverything: a song → stems, tempo and key in the names, melody MIDI, a video → a zip of the stems.
func songEverything() core.PipelineTemplate {
	st := stems.DefaultOptions()
	st.Preset, st.Format = stems.PresetFourFast, stems.FormatFLAC
	mi := midi.DefaultOptions()
	mi.Range = midi.RangeMelody
	vz := visualizer.DefaultStepOptions()
	vz.PresetID, vz.ShowJSON = "golden-hour", ""
	vz.Mode, vz.Aspect, vz.Height, vz.FPS = visualizer.ModeFull, "16:9", 1080, 30
	vz.Stems, vz.Words, vz.Mood = true, "none", true
	return buildTemplate(TplSongEverything, "Song to everything", "sparkles",
		"From one song: its stems named with tempo and key, the melody as MIDI, a music video, and a zip of the stems.",
		[]string{"music"},
		tstep{id: "stems", typ: stStems, opts: st},
		tstep{id: "tempo", typ: stBPMKey, from: "input", opts: struct{}{}},
		tstep{id: "name", typ: TypeRename, from: "stems", opts: RenameStep{Template: "{name} · {bpm} BPM · {key}"}},
		tstep{id: "melody", typ: stMIDI, from: "name", opts: mi, filter: roles("other"), keep: true},
		tstep{id: "video", typ: stVisualizer, from: "input", opts: vz, keep: true},
		tstep{id: "zip", typ: TypeZip, from: "name", opts: ZipStep{Together: true, Name: "{pipeline} {date}"}, keep: true},
	)
}

// verticalCut: a landscape video → no dead air → 9:16 with a title → a Post Builder reel.
func verticalCut() core.PipelineTemplate {
	cut := silence.DefaultStepOptions()
	cut.CutList = false
	vert := editstudio.DefaultAssembleRequest()
	vert.Aspect, vert.Fit, vert.Title, vert.Name = "9:16", "fit-blur", "{item}", "{item} (vertical)"
	post := posts.DefaultStepOptions()
	post.Format = "reel"
	return buildTemplate(TplVerticalCut, "Vertical cut for social", "crop",
		"Cut the dead air out of a landscape video, make it 9:16 with a title and turn it into a post-ready reel.",
		[]string{"media"},
		tstep{id: "cut", typ: stSilence, opts: cut},
		tstep{id: "vertical", typ: stVideoStudio, opts: vert, filter: roles("cut"), keep: true},
		tstep{id: "post", typ: stPostBuilder, opts: post, filter: roles("video"), keep: true},
	)
}

// sendToMyComputer: photos → 2048 px without location → one of your other computers (Local File Transfer).
// The device is the user's choice.
func sendToMyComputer() core.PipelineTemplate {
	small := imagebatch.DefaultStepOptions()
	return buildTemplate(TplSendToMyComputer, "Shrink photos and send them to my other computer", "arrow-left-right",
		"Shrink photos to 2048 px without location data and send them to a paired computer on the same network. Pick the device in the last step.",
		[]string{"image"},
		tstep{id: "shrink", typ: stImageBatch, opts: small},
		tstep{id: "send", typ: stLanShare, opts: lanshare.DefaultStepOptions(), keep: true, note: "Pick the device to send to"},
	)
}
