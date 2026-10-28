package ocr

// modelEntry is one sha-verified ONNX model file (SPEC.md §5.1). The OC1
// builder fills in exact sizes and, if a recognition model lacks its
// character dictionary, the dictionary file.
type modelEntry struct {
	File   string `json:"file"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type langPreset struct {
	Label    string
	Det, Rec *modelEntry // nil = the models bundled in the rapidocr wheel
}

const modelBase = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/"

func v5(kind, file, sha string, bytes int64) *modelEntry {
	return &modelEntry{File: file, URL: modelBase + kind + "/" + file, SHA256: sha, Bytes: bytes}
}

var v5Det = v5("det", "ch_PP-OCRv5_det_mobile.onnx", "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae", 4_819_576)

// Sizes for cyrillic, arabic and the v5 detector were measured; korean, greek, thai
// and devanagari are estimates (modelscope.cn was unreachable while building) and
// only feed the UI download note.
var presets = map[Language]langPreset{
	LangLatin:      {Label: "Latin, Chinese and Japanese"},
	LangCyrillic:   {Label: "Cyrillic", Det: v5Det, Rec: v5("rec", "cyrillic_PP-OCRv5_rec_mobile.onnx", "90f761b4bfcce0c8c561c0cb5c887b0971d3ec01c32164bdf7374a35b0982711", 8_074_092)},
	LangArabic:     {Label: "Arabic", Det: v5Det, Rec: v5("rec", "arabic_PP-OCRv5_rec_mobile.onnx", "c1192e632d0baa9146ae5b756a0e635e3dc63c1733737ebfd1629e87144e9295", 8_023_828)},
	LangKorean:     {Label: "Korean", Det: v5Det, Rec: v5("rec", "korean_PP-OCRv5_rec_mobile.onnx", "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b", 8_000_000)},
	LangGreek:      {Label: "Greek", Det: v5Det, Rec: v5("rec", "el_PP-OCRv5_rec_mobile.onnx", "b4368bccd557123c702b7549fee6cd1e94b581337d1c9b65310f109131542b7f", 8_000_000)},
	LangThai:       {Label: "Thai", Det: v5Det, Rec: v5("rec", "th_PP-OCRv5_rec_mobile.onnx", "de541dd83161c241ff426f7ecfd602a0ba77d686cf3ab9a6c255ea82fd08006e", 8_000_000)},
	LangDevanagari: {Label: "Devanagari (Hindi, Marathi, Nepali)", Det: v5Det, Rec: v5("rec", "devanagari_PP-OCRv5_rec_mobile.onnx", "d6f0a906580e3fa6b324a318718f1f31f268b6ea8ef985f91c2012a37f52c91e", 8_000_000)},
}

// languageOrder is the UI order.
var languageOrder = []Language{LangLatin, LangCyrillic, LangArabic, LangKorean, LangGreek, LangThai, LangDevanagari}

// Languages lists the language choices with their download sizes.
func Languages() []LanguageInfo {
	out := make([]LanguageInfo, 0, len(languageOrder))
	for _, id := range languageOrder {
		p := presets[id]
		var n int64
		for _, m := range []*modelEntry{p.Det, p.Rec} {
			if m != nil {
				n += m.Bytes
			}
		}
		out = append(out, LanguageInfo{ID: id, Label: p.Label, DownloadBytes: n})
	}
	return out
}
