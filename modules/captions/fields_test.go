package captions

import (
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestRepairAlt(t *testing.T) {
	long := strings.Repeat("A red bicycle leans on a blue wall. ", 12)
	tests := []struct {
		name, in, want string
	}{
		{"plain", "A dog on a beach.", "A dog on a beach."},
		{"image of", "Image of a dog on a beach", "A dog on a beach"},
		{"a photo of", "A photo of two cats", "Two cats"},
		{"picture showing", "picture showing a lake", "A lake"},
		{"the photograph of", "The photograph of a bridge.", "A bridge."},
		{"hashtags", "A dog on a beach #dog #beach", "A dog on a beach"},
		{"emoji", "A dog 🐶 on a beach 🏖️", "A dog on a beach"},
		{"newlines", "A dog\non a\n\nbeach", "A dog on a beach"},
		{"quotes", "\"A dog\"", "A dog"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := RepairAlt(tt.in); got != tt.want {
				t.Errorf("RepairAlt(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
	got := RepairAlt(long)
	if n := utf8.RuneCountInString(got); n > AltHardCap || n < 100 {
		t.Errorf("long alt has %d chars, want 100..%d", n, AltHardCap)
	}
	if !strings.HasSuffix(got, ".") {
		t.Errorf("long alt should end at a sentence: %q", got[len(got)-20:])
	}
	nospace := RepairAlt(strings.Repeat("x", 400))
	if utf8.RuneCountInString(nospace) != AltHardCap {
		t.Errorf("no-space alt = %d chars", utf8.RuneCountInString(nospace))
	}
}

func TestRepairCaption(t *testing.T) {
	tests := []struct {
		name, in string
		emoji    bool
		want     string
	}{
		{"hashtags removed", "Sunny day at the harbour #sunny #harbour", false, "Sunny day at the harbour"},
		{"hashtag mid", "Our #lisbon trip was lovely", false, "Our trip was lovely"},
		{"emoji off", "Sunny day ☀️ at the harbour 🌊", false, "Sunny day at the harbour"},
		{"emoji on", "Sunny day ☀️", true, "Sunny day ☀️"},
		{"lines kept", "Line one\n\nLine two", true, "Line one\n\nLine two"},
		{"non-latin hashtag", "Praia 海 #海 #praia", false, "Praia 海"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := RepairCaption(tt.in, tt.emoji); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
	big := RepairCaption(strings.Repeat("Hello there friend. ", 200), true)
	if n := utf8.RuneCountInString(big); n > CaptionMax {
		t.Errorf("caption has %d chars", n)
	}
}

func TestRepairHashtags(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		n    int
		want []string
	}{
		{"basic", []string{"#beach", "sunset", "#Golden_Hour"}, 5, []string{"#beach", "#sunset", "#Golden_Hour"}},
		{"limit", []string{"#a1", "#b2", "#c3", "#d4"}, 2, []string{"#a1", "#b2"}},
		{"zero", []string{"#a1"}, 0, []string{}},
		{"dedupe case", []string{"#Beach", "#beach", "#BEACH"}, 5, []string{"#Beach"}},
		{"spam", []string{"#love", "#instagood", "#photooftheday", "#harbour", "#like4like"}, 5, []string{"#harbour"}},
		{"one string", []string{"#harbour #boats, #sea"}, 5, []string{"#harbour", "#boats", "#sea"}},
		{"punctuation", []string{"#sun-set!", "#a.b"}, 5, []string{"#sunset", "#ab"}},
		{"non-latin", []string{"#海辺", "#praia", "#café", "#Москва"}, 5, []string{"#海辺", "#praia", "#café", "#Москва"}},
		{"digits only dropped", []string{"#2026", "#trip2026"}, 5, []string{"#trip2026"}},
		{"empty", []string{"#", "", "  "}, 5, []string{}},
		{"fullwidth hash", []string{"＃beach"}, 5, []string{"#beach"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RepairHashtags(tt.in, tt.n)
			if got == nil || !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestRepairTitle(t *testing.T) {
	tests := []struct{ in, want string }{
		{"Harbour at dusk.", "Harbour at dusk"},
		{"\"Harbour at dusk\"", "Harbour at dusk"},
		{"Harbour\nat dusk...", "Harbour at dusk"},
		{strings.Repeat("word ", 30), strings.TrimSpace(strings.Repeat("word ", 14))},
	}
	for _, tt := range tests {
		got := RepairTitle(tt.in)
		if got != tt.want {
			t.Errorf("RepairTitle(%q) = %q, want %q", tt.in, got, tt.want)
		}
		if utf8.RuneCountInString(got) > TitleMax {
			t.Errorf("title has %d chars", utf8.RuneCountInString(got))
		}
	}
}

func TestRepairKeywords(t *testing.T) {
	got := RepairKeywords([]string{"Harbour, Boats", "boat", "boats", "  Sunset.", "man", "woman", "black cat", "Muslim family", "Indian food", "#sea", ""})
	want := []string{"harbour", "boats", "boat", "sunset", "black cat", "indian food", "sea"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %#v, want %#v", got, want)
	}
	many := make([]string, 40)
	for i := range many {
		many[i] = "k" + strings.Repeat("x", i)
	}
	if got := RepairKeywords(many); len(got) != 25 {
		t.Errorf("got %d keywords, want 25", len(got))
	}
	if got := RepairKeywords(nil); got == nil || len(got) != 0 {
		t.Errorf("nil input should give an empty non-nil slice, got %#v", got)
	}
}

func TestComposeName(t *testing.T) {
	tests := []struct {
		name  string
		in    string
		pat   NamePattern
		kebab bool
		date  string
		n     int
		want  string
	}{
		{"name", "Dog on the beach", NameOnly, false, "", 1, "Dog on the beach"},
		{"date", "Dog on the beach", NameDate, false, "2026-05-02", 1, "2026-05-02 Dog on the beach"},
		{"date kebab", "Dog on the beach", NameDate, true, "2026-05-02", 1, "2026-05-02-dog-on-the-beach"},
		{"number", "Dog", NameNumber, false, "", 3, "03 Dog"},
		{"number kebab", "Dog On Beach!", NameNumber, true, "", 12, "12-dog-on-beach"},
		{"invalid chars", `a/b\c:d*e?f"g<h>i|j`, NameOnly, false, "", 1, "a b c d e f g h i j"},
		{"trailing dot", "Harbour.", NameOnly, false, "", 1, "Harbour"},
		{"reserved", "CON", NameOnly, false, "", 1, "CON_"},
		{"empty", "///", NameOnly, false, "", 1, ""},
		{"emoji", "Dog 🐶 beach", NameOnly, false, "", 1, "Dog beach"},
		{"no date given", "Dog", NameDate, false, "", 1, "Dog"},
		{"non-latin kebab", "Praia do Guincho 海", NameOnly, true, "", 1, "praia-do-guincho-海"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ComposeName(tt.in, tt.pat, tt.kebab, tt.date, tt.n); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
	long := ComposeName(strings.Repeat("harbour ", 20), NameDate, false, "2026-05-02", 1)
	if n := utf8.RuneCountInString(long); n > NameMax {
		t.Errorf("name has %d chars: %q", n, long)
	}
	if !strings.HasPrefix(long, "2026-05-02 harbour") || strings.HasSuffix(long, " ") {
		t.Errorf("long name: %q", long)
	}
}

func TestRepairFields(t *testing.T) {
	raw := Fields{
		Alt: "Image of a dog #dog", Caption: "Walkies 🐶 #dog", Hashtags: []string{"#love", "#dog", "#beach"},
		Title: "Dog.", Keywords: []string{"Dog", "man"}, Name: "dog on beach", Description: "A **dog**.",
	}
	o := DefaultOptions()
	o.Hashtags = 2
	o.NamePattern = NameNumber
	got := RepairFields(raw, PresetFields(PresetEverything), o, "2026-05-02", 4, nil)
	want := Fields{
		Alt: "A dog", Caption: "Walkies", Hashtags: []string{"#dog", "#beach"}, Title: "Dog",
		Keywords: []string{"dog"}, Name: "04 dog on beach", Description: "A dog.",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %#v\nwant %#v", got, want)
	}
	// Edited fields and fields outside the preset stay as they are.
	got = RepairFields(raw, PresetFields(PresetPosting), o, "", 1, map[Field]bool{FieldAlt: true})
	if got.Alt != raw.Alt || got.Title != raw.Title || got.Caption != "Walkies" {
		t.Errorf("edited/unwanted fields were touched: %#v", got)
	}
}
