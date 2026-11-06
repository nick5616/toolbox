package tts

// VoiceInfo describes one Kokoro voice for the picker.
type VoiceInfo struct {
	ID       string `json:"id"`       // "af_heart"
	Name     string `json:"name"`     // "Heart"
	Group    string `json:"group"`    // "American English", "British English", ...
	Lang     string `json:"lang"`     // espeak language code the engine is given
	Gender   string `json:"gender"`   // "female" | "male"
	Sample   string `json:"sample"`   // the preview sentence in the voice's language
	Featured bool   `json:"featured"` // good all-round voices, listed first
}

// DefaultVoice is the voice a new job starts with.
const DefaultVoice = "af_heart"

const (
	sampleEN = "Hello, this is how I sound. I can read your documents aloud."
	sampleES = "Hola, así es como sueno. Puedo leer tus documentos en voz alta."
	sampleFR = "Bonjour, voici ma voix. Je peux lire vos documents à voix haute."
	sampleHI = "नमस्ते, यह मेरी आवाज़ है। मैं आपके दस्तावेज़ पढ़ सकता हूँ।"
	sampleIT = "Ciao, ecco come suono. Posso leggere i tuoi documenti ad alta voce."
	samplePT = "Olá, é assim que eu soo. Posso ler os seus documentos em voz alta."
)

func v(id, name, group, lang, gender, sample string, featured bool) VoiceInfo {
	return VoiceInfo{ID: id, Name: name, Group: group, Lang: lang, Gender: gender, Sample: sample, Featured: featured}
}

// voices is the pinned voices.bin's English, Spanish, French, Hindi, Italian
// and Portuguese voices. Japanese and Chinese voices need a separate
// grapheme-to-phoneme library, so they aren't offered.
var voices = []VoiceInfo{
	v("af_heart", "Heart", "American English", "en-us", "female", sampleEN, true),
	v("af_bella", "Bella", "American English", "en-us", "female", sampleEN, true),
	v("af_nicole", "Nicole", "American English", "en-us", "female", sampleEN, false),
	v("af_sarah", "Sarah", "American English", "en-us", "female", sampleEN, false),
	v("af_sky", "Sky", "American English", "en-us", "female", sampleEN, false),
	v("af_nova", "Nova", "American English", "en-us", "female", sampleEN, false),
	v("af_alloy", "Alloy", "American English", "en-us", "female", sampleEN, false),
	v("af_aoede", "Aoede", "American English", "en-us", "female", sampleEN, false),
	v("af_jessica", "Jessica", "American English", "en-us", "female", sampleEN, false),
	v("af_kore", "Kore", "American English", "en-us", "female", sampleEN, false),
	v("af_river", "River", "American English", "en-us", "female", sampleEN, false),
	v("am_michael", "Michael", "American English", "en-us", "male", sampleEN, true),
	v("am_adam", "Adam", "American English", "en-us", "male", sampleEN, false),
	v("am_echo", "Echo", "American English", "en-us", "male", sampleEN, false),
	v("am_eric", "Eric", "American English", "en-us", "male", sampleEN, false),
	v("am_fenrir", "Fenrir", "American English", "en-us", "male", sampleEN, false),
	v("am_liam", "Liam", "American English", "en-us", "male", sampleEN, false),
	v("am_onyx", "Onyx", "American English", "en-us", "male", sampleEN, false),
	v("am_puck", "Puck", "American English", "en-us", "male", sampleEN, false),
	v("am_santa", "Santa", "American English", "en-us", "male", sampleEN, false),
	v("bf_emma", "Emma", "British English", "en-gb", "female", sampleEN, true),
	v("bf_alice", "Alice", "British English", "en-gb", "female", sampleEN, false),
	v("bf_isabella", "Isabella", "British English", "en-gb", "female", sampleEN, false),
	v("bf_lily", "Lily", "British English", "en-gb", "female", sampleEN, false),
	v("bm_george", "George", "British English", "en-gb", "male", sampleEN, true),
	v("bm_daniel", "Daniel", "British English", "en-gb", "male", sampleEN, false),
	v("bm_fable", "Fable", "British English", "en-gb", "male", sampleEN, false),
	v("bm_lewis", "Lewis", "British English", "en-gb", "male", sampleEN, false),
	v("ef_dora", "Dora", "Spanish", "es", "female", sampleES, false),
	v("em_alex", "Alex", "Spanish", "es", "male", sampleES, false),
	v("ff_siwis", "Siwis", "French", "fr-fr", "female", sampleFR, false),
	v("hf_alpha", "Alpha", "Hindi", "hi", "female", sampleHI, false),
	v("hf_beta", "Beta", "Hindi", "hi", "female", sampleHI, false),
	v("hm_omega", "Omega", "Hindi", "hi", "male", sampleHI, false),
	v("hm_psi", "Psi", "Hindi", "hi", "male", sampleHI, false),
	v("if_sara", "Sara", "Italian", "it", "female", sampleIT, false),
	v("im_nicola", "Nicola", "Italian", "it", "male", sampleIT, false),
	v("pf_dora", "Dora", "Portuguese (Brazil)", "pt-br", "female", samplePT, false),
	v("pm_alex", "Alex", "Portuguese (Brazil)", "pt-br", "male", samplePT, false),
}

// lookupVoice finds a voice by id.
func lookupVoice(id string) (VoiceInfo, bool) {
	for _, vi := range voices {
		if vi.ID == id {
			return vi, true
		}
	}
	return VoiceInfo{}, false
}

// Voices lists every offered voice (a copy).
func Voices() []VoiceInfo { return append([]VoiceInfo{}, voices...) }
