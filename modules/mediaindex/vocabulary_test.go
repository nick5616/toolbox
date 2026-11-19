package mediaindex

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

type vocabRow struct {
	id, category, display, parent string
	prompts                       []string
	threshold                     string
}

var vocabCategories = map[string]bool{
	"people": true, "animals": true, "food": true, "nature": true,
	"things": true, "vehicles": true, "documents": true, "art": true,
}

var vocabSlug = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
var vocabWord = regexp.MustCompile(`[a-z0-9]+(?:'[a-z]+)?`)

func parseVocabulary(t *testing.T) []vocabRow {
	t.Helper()
	if bytes.Contains(Vocabulary, []byte("\r")) {
		t.Fatal("vocabulary.tsv must use LF line endings")
	}
	var rows []vocabRow
	for n, line := range strings.Split(string(Vocabulary), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		cols := strings.Split(line, "\t")
		if len(cols) != 6 && len(cols) != 5 {
			t.Fatalf("line %d: %d columns, want 5 or 6: %q", n+1, len(cols), line)
		}
		r := vocabRow{id: cols[0], category: cols[1], display: cols[2], parent: cols[4]}
		r.prompts = strings.Split(cols[3], "|")
		if len(cols) == 6 {
			r.threshold = cols[5]
		}
		rows = append(rows, r)
	}
	return rows
}

func TestVocabularyShape(t *testing.T) {
	rows := parseVocabulary(t)
	ids := map[string]vocabRow{}
	displays := map[string]string{}
	for _, r := range rows {
		if !vocabSlug.MatchString(r.id) {
			t.Errorf("id %q is not a slug", r.id)
		}
		if _, dup := ids[r.id]; dup {
			t.Errorf("duplicate id %q", r.id)
		}
		ids[r.id] = r
		if r.display == "" || r.display != strings.ToLower(r.display) || strings.TrimSpace(r.display) != r.display {
			t.Errorf("%s: display %q must be non-empty, lowercase and trimmed", r.id, r.display)
		}
		if other, dup := displays[r.display]; dup {
			t.Errorf("display %q is used by both %s and %s", r.display, other, r.id)
		}
		displays[r.display] = r.id
		if !vocabCategories[r.category] {
			t.Errorf("%s: unknown category %q", r.id, r.category)
		}
		if n := len(r.prompts); n < 1 || n > 3 {
			t.Errorf("%s: %d prompts, want 1 to 3", r.id, n)
		}
		for _, p := range r.prompts {
			if strings.TrimSpace(p) == "" || strings.TrimSpace(p) != p {
				t.Errorf("%s: empty or untrimmed prompt %q", r.id, p)
			}
			if len(p) > 80 {
				t.Errorf("%s: prompt longer than 80 chars: %q", r.id, p)
			}
			if strings.ContainsAny(p, "\t\r\n") {
				t.Errorf("%s: prompt has a control character", r.id)
			}
		}
		if r.threshold != "" {
			f, err := strconv.ParseFloat(r.threshold, 64)
			if err != nil || f <= 0 || f >= 1 {
				t.Errorf("%s: threshold %q must be a float in (0, 1)", r.id, r.threshold)
			}
		}
	}
	for _, r := range rows {
		depth := 1
		seen := map[string]bool{r.id: true}
		for cur := r; cur.parent != ""; {
			p, ok := ids[cur.parent]
			if !ok {
				t.Errorf("%s: parent %q does not exist", cur.id, cur.parent)
				break
			}
			if seen[p.id] {
				t.Errorf("%s: parent cycle through %q", r.id, p.id)
				break
			}
			seen[p.id] = true
			depth++
			cur = p
		}
		if depth > 4 {
			t.Errorf("%s: depth %d, want at most 4", r.id, depth)
		}
	}
	if len(rows) < 1300 || len(rows) > 1800 {
		t.Errorf("%d labels, want 1300 to 1800", len(rows))
	}
	per := map[string]int{}
	for _, r := range rows {
		per[r.category]++
	}
	for c := range vocabCategories {
		if per[c] < 50 {
			t.Errorf("category %s has only %d labels", c, per[c])
		}
	}
}

// Single words that describe people (identity, gender, age, religion, health,
// body, looks) or are offensive. Whole words, case-insensitive.
var bannedWords = []string{
	"man", "men", "woman", "women", "boy", "boys", "girl", "girls", "male", "female",
	"guy", "guys", "lady", "ladies", "gentleman", "gentlemen", "he", "she", "his", "hers", "him",
	"bride", "groom", "husband", "wife", "boyfriend", "girlfriend", "mother", "father", "mom", "dad",
	"son", "daughter", "grandma", "grandpa", "grandmother", "grandfather",
	"asian", "african", "european", "latino", "latina", "hispanic", "arab", "caucasian", "ethnic",
	"racial", "race-based", "indian", "chinese", "japanese", "korean", "mexican", "french", "german",
	"italian", "british", "russian", "american", "english", "irish", "turkish", "greek",
	"muslim", "christian", "jewish", "jew", "hindu", "buddhist", "sikh", "catholic", "protestant",
	"atheist", "religious", "gay", "lesbian", "bisexual", "homosexual", "transgender", "queer", "lgbt",
	"disabled", "disability", "blind", "deaf", "autistic", "cancer", "obese", "pregnant", "wheelchair",
	"fat", "skinny", "slim", "sexy", "hot-looking", "nude", "naked", "topless", "lingerie", "bikini",
	"porn", "nsfw", "erotic", "sex", "sexual", "breast", "breasts", "ugly", "handsome", "attractive",
	"beautiful", "pretty", "cute-girl", "elderly", "senior", "teenager", "teen", "adult", "young",
	"gun", "guns", "rifle", "pistol", "weapon", "weapons", "bomb", "blood", "corpse", "murder",
	"kill", "killing", "terrorist", "nazi", "swastika", "slave", "slur", "racist", "hate",
}

// Colour or skin words are banned only next to a word about people.
var bannedColours = []string{"white", "black", "brown", "yellow", "red", "dark", "light", "pale", "tan"}
var bannedPeopleNouns = []string{"person", "people", "man", "men", "woman", "women", "child", "children", "kid", "kids", "skin", "skinned", "folks", "persons"}

var bannedPhrases = []string{
	"old people", "old person", "old man", "old woman", "older people", "young people", "young person",
	"disabled people", "fat people", "thin people", "tall person", "short person", "mixed race",
	"people of color", "person of color", "skin color", "skin tone", "body type", "body shape",
}

func TestVocabularyNoIdentityLabels(t *testing.T) {
	words := map[string]bool{}
	for _, w := range bannedWords {
		words[w] = true
	}
	phrases := append([]string{}, bannedPhrases...)
	for _, c := range bannedColours {
		for _, p := range bannedPeopleNouns {
			phrases = append(phrases, c+" "+p)
		}
	}
	for _, r := range parseVocabulary(t) {
		texts := append([]string{r.display}, r.prompts...)
		for _, text := range texts {
			lower := strings.ToLower(text)
			toks := vocabWord.FindAllString(lower, -1)
			for _, tok := range toks {
				if words[tok] {
					t.Errorf("%s: banned word %q in %q", r.id, tok, text)
				}
			}
			padded := " " + strings.Join(toks, " ") + " "
			for _, ph := range phrases {
				if strings.Contains(padded, " "+ph+" ") {
					t.Errorf("%s: banned phrase %q in %q", r.id, ph, text)
				}
			}
		}
	}
}

func TestVocabularyStarterLabelsKept(t *testing.T) {
	ids := map[string]bool{}
	for _, r := range parseVocabulary(t) {
		ids[r.id] = true
	}
	for _, id := range []string{
		"person", "group", "selfie", "wedding", "birthday", "concert", "animal", "dog", "cat", "bird",
		"horse", "fish", "food", "fruit", "apple", "banana", "pizza", "cake", "coffee", "drink", "salad",
		"bread", "beach", "sea", "mountain", "forest", "sunset", "sky", "snow", "flower", "city",
		"building", "garden", "table", "chair", "book", "phone", "laptop", "computer", "guitar",
		"instrument", "camera", "cup", "car", "bicycle", "train", "airplane", "boat", "vehicle",
		"document", "screenshot", "receipt", "whiteboard", "slide", "code", "chart", "map",
		"handwriting", "painting", "sketch", "illustration", "logo",
	} {
		if !ids[id] {
			t.Errorf("starter label %q was removed (ids are stable)", id)
		}
	}
}
