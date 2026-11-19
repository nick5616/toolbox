package grade

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

type vectors struct {
	Valid   []json.RawMessage `json:"valid"`
	Invalid []struct {
		Why    string          `json:"why"`
		Recipe json.RawMessage `json:"recipe"`
	} `json:"invalid"`
	Clamped []struct {
		Why string          `json:"why"`
		In  json.RawMessage `json:"in"`
		Out json.RawMessage `json:"out"`
	} `json:"clamped"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile("../../core/testdata/grade-recipes.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// canon decodes JSON into any so two documents compare regardless of key order.
func canon(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestSharedVectorsValid(t *testing.T) {
	for i, raw := range loadVectors(t).Valid {
		r, err := ParseRecipe(raw)
		if err != nil {
			t.Fatalf("valid[%d]: %v", i, err)
		}
		out, _ := json.Marshal(r)
		if !reflect.DeepEqual(canon(t, out), canon(t, raw)) {
			t.Errorf("valid[%d] changed:\n got %s\nwant %s", i, out, raw)
		}
	}
}

func TestSharedVectorsInvalid(t *testing.T) {
	for _, v := range loadVectors(t).Invalid {
		if _, err := ParseRecipe(v.Recipe); err == nil {
			t.Errorf("%s: accepted", v.Why)
		}
	}
}

func TestSharedVectorsClamped(t *testing.T) {
	for _, v := range loadVectors(t).Clamped {
		r, err := ParseRecipe(v.In)
		if err != nil {
			t.Fatalf("%s: %v", v.Why, err)
		}
		out, _ := json.Marshal(r)
		if !reflect.DeepEqual(canon(t, out), canon(t, v.Out)) {
			t.Errorf("%s:\n got %s\nwant %s", v.Why, out, v.Out)
		}
	}
}

func recipeWith(ops ...Op) Recipe {
	return Recipe{V: 1, Name: "t", Tier: TierMine, WildCurve: "linear", Ops: ops}
}

func raw(s string) json.RawMessage { return json.RawMessage(s) }

func TestNormalizeClampsAndDrops(t *testing.T) {
	long := strings.Repeat("é", 60)
	var ops []Op
	for i := 0; i < 20; i++ {
		ops = append(ops, Op{ID: opID(1, i), Kind: "grain", On: true, Amount: 0.5, Region: Region{Kind: "all"}})
	}
	r := recipeWith(ops...)
	r.Name = "  " + long + "  "
	got, err := Normalize(r)
	if err != nil {
		t.Fatal(err)
	}
	if n := len([]rune(got.Name)); n != MaxNameLen {
		t.Errorf("name has %d runes", n)
	}
	if len(got.Ops) != MaxOps {
		t.Errorf("%d ops, want %d", len(got.Ops), MaxOps)
	}

	for _, tc := range []struct {
		name string
		op   Op
		want func(Op) bool
	}{
		{"amount below 0", Op{ID: "aaaaaa", Kind: "grain", Amount: -2, Region: Region{Kind: "all"}}, func(o Op) bool { return o.Amount == 0 }},
		{"unknown region", Op{ID: "aaaaaa", Kind: "grain", Region: Region{Kind: "sky", Feather: 3}}, func(o Op) bool { return o.Region == Region{Kind: "all"} }},
		{"region ranges", Op{ID: "aaaaaa", Kind: "grain", Region: Region{Kind: "near", Split: 4, Feather: -1}}, func(o Op) bool { return o.Region.Split == 1 && o.Region.Feather == 0 }},
		{"luma region keeps soft only", Op{ID: "aaaaaa", Kind: "grain", Region: Region{Kind: "shadows", Soft: 0.4, Feather: 0.9}}, func(o Op) bool { return o.Region == Region{Kind: "shadows", Soft: 0.4} }},
		{"anim speed", Op{ID: "aaaaaa", Kind: "grain", Region: Region{Kind: "all"}, Anim: &Anim{Speed: 100, Wave: "zigzag"}}, func(o Op) bool { return o.Anim.Speed == 6 && o.Anim.Wave == "sine" }},
		{"anim slow", Op{ID: "aaaaaa", Kind: "grain", Region: Region{Kind: "all"}, Anim: &Anim{Speed: 0, Wave: "beat"}}, func(o Op) bool { return o.Anim.Speed == 0.05 && o.Anim.Wave == "beat" }},
	} {
		got, err := Normalize(recipeWith(tc.op))
		if err != nil || len(got.Ops) != 1 || !tc.want(got.Ops[0]) {
			t.Errorf("%s: %+v, %v", tc.name, got.Ops, err)
		}
	}
}

func TestNormalizeParams(t *testing.T) {
	op := Op{ID: "aaaaaa", Kind: "balance", On: true, Amount: 1, Region: Region{Kind: "all"}, Params: map[string]json.RawMessage{
		"exposure": raw("-9"), "contrast": raw(`"high"`), "nonsense": raw("1"), "saturation": raw("1.5"),
	}}
	hsl := Op{ID: "bbbbbb", Kind: "hsl", Region: Region{Kind: "all"}, Params: map[string]json.RawMessage{
		"hue": raw("[500,0,0,0,0,-500]"), "sat": raw("[0,0,0]"), // wrong length: dropped
	}}
	grad := Op{ID: "cccccc", Kind: "gradmap", Region: Region{Kind: "all"}, Params: map[string]json.RawMessage{
		"stops": raw(`"#ABC@0,#00ff00@2"`), "source": raw(`"depth"`), "blend": raw(`"warp"`),
	}}
	oneStop := Op{ID: "dddddd", Kind: "gradmap", Region: Region{Kind: "all"}, Params: map[string]json.RawMessage{"stops": raw(`"#ffffff@0"`)}}
	post := Op{ID: "eeeeee", Kind: "posterize", Region: Region{Kind: "all"}, Params: map[string]json.RawMessage{"levels": raw("99")}}
	tr := Op{ID: "ffffff", Kind: "transfer", Region: Region{Kind: "all"}, Params: map[string]json.RawMessage{"stats": raw("[" + strings.Repeat("200,", 17) + "200]")}}
	got, err := Normalize(recipeWith(op, hsl, grad, oneStop, post, tr))
	if err != nil {
		t.Fatal(err)
	}
	p := func(i int, k string) string { return string(got.Ops[i].Params[k]) }
	if p(0, "exposure") != "-3" || p(0, "saturation") != "1.5" {
		t.Errorf("balance params: %v", got.Ops[0].Params)
	}
	if _, ok := got.Ops[0].Params["contrast"]; ok {
		t.Error("a string contrast was kept")
	}
	if _, ok := got.Ops[0].Params["nonsense"]; ok {
		t.Error("an unknown param was kept")
	}
	if p(1, "hue") != "[180,0,0,0,0,-180]" {
		t.Errorf("hue = %s", p(1, "hue"))
	}
	if _, ok := got.Ops[1].Params["sat"]; ok {
		t.Error("a short array was kept")
	}
	if p(2, "stops") != `"#aabbcc@0,#00ff00@1"` {
		t.Errorf("stops = %s", p(2, "stops"))
	}
	if p(2, "source") != `"depth"` {
		t.Errorf("source = %s", p(2, "source"))
	}
	if _, ok := got.Ops[2].Params["blend"]; ok {
		t.Error("an unknown enum value was kept")
	}
	if len(got.Ops[3].Params) != 0 {
		t.Errorf("one gradient stop was kept: %v", got.Ops[3].Params)
	}
	if p(4, "levels") != "16" {
		t.Errorf("levels = %s", p(4, "levels"))
	}
	var stats []float64
	_ = json.Unmarshal(got.Ops[5].Params["stats"], &stats)
	if len(stats) != 18 || stats[0] != 100 || stats[1] != 128 || stats[3] != 128 {
		t.Errorf("transfer stats = %v", stats)
	}
}

func TestNormalizeErrors(t *testing.T) {
	good := Op{ID: "aaaaaa", Kind: "grain", Region: Region{Kind: "all"}}
	for name, r := range map[string]Recipe{
		"version":       {V: 3, Name: "x", Tier: TierFilm, WildCurve: "linear"},
		"tier":          {V: 1, Name: "x", Tier: "tasteful", WildCurve: "linear"},
		"curve":         {V: 1, Name: "x", Tier: TierFilm, WildCurve: "sine"},
		"short id":      recipeWith(Op{ID: "abc", Kind: "grain", Region: Region{Kind: "all"}}),
		"duplicate ids": recipeWith(good, good),
	} {
		if _, err := Normalize(r); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	// An unknown kind is dropped, but its id still counts as taken.
	if _, err := Normalize(recipeWith(Op{ID: "aaaaaa", Kind: "teleport"}, good)); err == nil {
		t.Error("duplicate id across a dropped op accepted")
	}
}

func TestEveryOpKindHasASpec(t *testing.T) {
	if len(OpKinds()) != 26 {
		t.Errorf("%d op kinds, want 26 (SPEC §E3.1)", len(OpKinds()))
	}
	colorOnly := 0
	for _, s := range opSpecs {
		if s.ColorOnly {
			colorOnly++
		}
		for _, name := range s.Order {
			if _, ok := s.Params[name]; !ok {
				t.Errorf("%s: ordered param %q has no spec", s.Kind, name)
			}
		}
		if len(s.Order) != len(s.Params) {
			t.Errorf("%s: %d ordered, %d specified", s.Kind, len(s.Order), len(s.Params))
		}
	}
	if colorOnly != 13 {
		t.Errorf("%d colour-only ops, want 13", colorOnly)
	}
}

func TestRegionsUsed(t *testing.T) {
	r := recipeWith(
		Op{ID: "aaaaaa", Kind: "grain", On: true, Region: Region{Kind: "background"}},
		Op{ID: "bbbbbb", Kind: "depthfog", On: true, Region: Region{Kind: "all"}},
		Op{ID: "cccccc", Kind: "gradmap", On: true, Region: Region{Kind: "people"}, Params: map[string]json.RawMessage{"source": raw(`"depth"`)}},
		Op{ID: "dddddd", Kind: "grain", On: false, Region: Region{Kind: "near"}},
	)
	got := RegionsUsed(r)
	want := []string{"subject", "depth", "people"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("RegionsUsed = %v, want %v", got, want)
	}
	if n := MapsNeeded(r); !reflect.DeepEqual(n, []string{"subject", "depth"}) {
		t.Errorf("MapsNeeded = %v", n)
	}
}
