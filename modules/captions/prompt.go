package captions

import (
	"encoding/json"
	"fmt"
	"strings"
)

// NoIdentifyRule is the rule that keeps the model from naming or profiling
// people (SPEC.md §4.1). A test asserts it is in every system prompt.
const NoIdentifyRule = "Never identify people or guess who they are, their age, ethnicity, gender identity, health or religion. Describe people neutrally (\"a person in a red coat\", \"two children\", \"a man on stage\"). Use a person's or pet's name only when the context or the note for this file gives it."

// RetryNote is added to the prompt after a reply that wasn't valid JSON.
const RetryNote = "Reply only with JSON matching the schema."

// effectiveFields are the fields a job produces: the preset's, minus
// hashtags when none are wanted, plus the name when copies will be renamed.
func effectiveFields(o Options) []Field {
	out := []Field{}
	for _, f := range PresetFields(o.Preset) {
		if f == FieldHashtags && o.Hashtags <= 0 {
			continue
		}
		out = append(out, f)
	}
	if o.Then == ThenRenameCopies {
		have := false
		for _, f := range out {
			have = have || f == FieldName
		}
		if !have {
			out = append(out, FieldName)
		}
	}
	return out
}

func toneText(t Tone) string {
	switch t {
	case TonePlain:
		return "plain and factual"
	case TonePlayful:
		return "playful and light"
	case ToneProfessional:
		return "professional and polished"
	case TonePoetic:
		return "poetic and evocative"
	default:
		return "warm and friendly"
	}
}

func captionLength(l Length) string {
	switch l {
	case LengthShort:
		return "one short sentence (under 90 characters)"
	case LengthLong:
		return "three to five sentences (up to 600 characters)"
	default:
		return "one or two sentences (up to 250 characters)"
	}
}

func descriptionLength(l Length) string {
	switch l {
	case LengthShort:
		return "2 sentences"
	case LengthLong:
		return "up to 8 sentences"
	default:
		return "2 to 5 sentences"
	}
}

// fieldRule is the instruction for one field.
func fieldRule(f Field, o Options) string {
	switch f {
	case FieldAlt:
		return fmt.Sprintf("alt: alt text for a screen reader. Describe what is visible in one sentence of at most %d characters. Do not start with \"image of\", \"picture of\" or \"photo of\". No hashtags, no emoji.", AltPreferred)
	case FieldDescription:
		return fmt.Sprintf("description: a longer plain-text description of %s. No hashtags, no emoji, no lists.", descriptionLength(o.Length))
	case FieldCaption:
		emoji := "Do not use emoji."
		if o.Emoji {
			emoji = "You may use one or two fitting emoji."
		}
		return fmt.Sprintf("caption: a social media caption, %s, written in a %s tone. Do not put hashtags in the caption. %s", captionLength(o.Length), toneText(o.Tone), emoji)
	case FieldHashtags:
		return fmt.Sprintf("hashtags: up to %d specific hashtags that describe this picture, each starting with # and using only letters, digits or underscores. Avoid generic tags such as #love, #instagood or #photooftheday.", o.Hashtags)
	case FieldTitle:
		return fmt.Sprintf("title: a short title of at most %d characters, with no period at the end.", TitleMax)
	case FieldKeywords:
		return "keywords: 5 to 25 lowercase single-concept keywords (singular nouns, places, objects, colours, activities). Never include terms about a person's identity."
	case FieldName:
		return "name: 2 to 6 plain words that describe this file, for a file name. No punctuation, no extension."
	}
	return ""
}

// SystemPrompt holds the rules for the model.
func SystemPrompt(o Options, fields []Field) string {
	lang := "English"
	if strings.TrimSpace(o.Language) != "" {
		lang = strings.TrimSpace(o.Language)
	}
	var b strings.Builder
	b.WriteString("You write text about photos and videos for the person who owns them. You look at the pictures you are given and reply with JSON only.\n\n")
	b.WriteString("Rules:\n")
	b.WriteString("- Describe only what is visible in the pictures or given in the context, the note and the hints. Do not invent details.\n")
	b.WriteString("- " + NoIdentifyRule + "\n")
	if o.ReadText {
		b.WriteString("- You may quote words that are clearly legible in the picture. Never invent text that isn't legible: write \"a sign\" or \"a label\" instead.\n")
	} else {
		b.WriteString("- Do not quote or transcribe text that is visible in the picture. Never invent text: write \"a sign\" instead.\n")
	}
	b.WriteString("- The hints come from an automatic index and may be wrong; trust the picture over them.\n")
	b.WriteString(fmt.Sprintf("- Write all text in %s.\n\n", lang))
	b.WriteString("Fields to write:\n")
	for _, f := range fields {
		b.WriteString("- " + fieldRule(f, o) + "\n")
	}
	return b.String()
}

// PromptInput is what the user prompt is built from.
type PromptInput struct {
	Context string
	Note    string
	Labels  []string
	Text    string
	Date    string // yyyy-mm-dd
	Frames  int    // > 1: the pictures are frames of one video
	Fields  []Field
}

// UserPrompt holds the batch context, the file's note, the hints, the date
// and the fields wanted.
func UserPrompt(in PromptInput) string {
	var b strings.Builder
	if in.Frames > 1 {
		b.WriteString(fmt.Sprintf("The %d pictures are frames from one video, in time order. Describe the video as a whole.\n", in.Frames))
	} else {
		b.WriteString("Describe the picture.\n")
	}
	if c := strings.TrimSpace(in.Context); c != "" {
		b.WriteString("\nContext from the owner: " + c + "\n")
	}
	if n := strings.TrimSpace(in.Note); n != "" {
		b.WriteString("Note for this file: " + n + "\n")
	}
	if len(in.Labels) > 0 || strings.TrimSpace(in.Text) != "" {
		var parts []string
		if len(in.Labels) > 0 {
			parts = append(parts, "Labels: "+strings.Join(in.Labels, ", "))
		}
		if t := strings.TrimSpace(in.Text); t != "" {
			parts = append(parts, "Text found: "+oneLine(t))
		}
		b.WriteString("Hints: " + strings.Join(parts, "; ") + "\n")
	}
	if in.Date != "" {
		b.WriteString("File date: " + in.Date + "\n")
	}
	names := make([]string, 0, len(in.Fields))
	for _, f := range in.Fields {
		names = append(names, string(f))
	}
	b.WriteString("\nReply with a JSON object with these fields: " + strings.Join(names, ", ") + ".")
	return b.String()
}

// Schema is the JSON schema of the reply for the given fields.
func Schema(fields []Field, hashtags int) json.RawMessage {
	var props, req []string
	for _, f := range fields {
		typ := `{"type":"string"}`
		switch f {
		case FieldHashtags:
			typ = fmt.Sprintf(`{"type":"array","items":{"type":"string"},"maxItems":%d}`, max(hashtags, 1))
		case FieldKeywords:
			typ = `{"type":"array","items":{"type":"string"},"maxItems":25}`
		}
		props = append(props, fmt.Sprintf("%q:%s", string(f), typ))
		req = append(req, fmt.Sprintf("%q", string(f)))
	}
	return json.RawMessage(fmt.Sprintf(`{"type":"object","properties":{%s},"required":[%s],"additionalProperties":false}`,
		strings.Join(props, ","), strings.Join(req, ",")))
}

func stripFence(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
		s = strings.TrimSuffix(strings.TrimSpace(s), "```")
	}
	return strings.TrimSpace(s)
}

// rawFields accepts the lists as arrays or as one string.
type rawFields struct {
	Alt         string          `json:"alt"`
	Description string          `json:"description"`
	Caption     string          `json:"caption"`
	Hashtags    json.RawMessage `json:"hashtags"`
	Title       string          `json:"title"`
	Keywords    json.RawMessage `json:"keywords"`
	Name        string          `json:"name"`
}

func listOf(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return []string{}
	}
	var arr []string
	if json.Unmarshal(raw, &arr) == nil {
		return append([]string{}, arr...)
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return []string{s}
	}
	return []string{}
}

// ParseReply reads the model's JSON reply. ok is false when it isn't a JSON
// object with at least one wanted field.
func ParseReply(reply string, fields []Field) (Fields, bool) {
	s := stripFence(reply)
	if i := strings.IndexByte(s, '{'); i > 0 {
		s = s[i:]
	}
	if j := strings.LastIndexByte(s, '}'); j >= 0 {
		s = s[:j+1]
	}
	var r rawFields
	if err := json.Unmarshal([]byte(s), &r); err != nil {
		return Fields{}, false
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(s), &obj); err != nil {
		return Fields{}, false
	}
	found := false
	for _, f := range fields {
		if _, ok := obj[string(f)]; ok {
			found = true
		}
	}
	if !found {
		return Fields{}, false
	}
	// Only the wanted fields are kept, whatever else the model added.
	out := Fields{Hashtags: []string{}, Keywords: []string{}}
	for _, f := range fields {
		switch f {
		case FieldAlt:
			out.Alt = r.Alt
		case FieldDescription:
			out.Description = r.Description
		case FieldCaption:
			out.Caption = r.Caption
		case FieldTitle:
			out.Title = r.Title
		case FieldName:
			out.Name = r.Name
		case FieldHashtags:
			out.Hashtags = listOf(r.Hashtags)
		case FieldKeywords:
			out.Keywords = listOf(r.Keywords)
		}
	}
	return out, true
}
