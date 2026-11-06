package packs

import "testing"

// The Documents pack (Phase 12): pandoc + typst + monolith, about 64 MB to
// download on both supported platforms, each a dep with an installer module.
func TestDocsPackShape(t *testing.T) {
	var pack PackSpec
	for _, p := range Catalog() {
		if p.ID == "docs" {
			pack = p
		}
	}
	if pack.ID == "" || pack.Name != "Documents" {
		t.Fatalf("pack: %+v", pack)
	}
	comps := map[string]ComponentSpec{}
	for _, c := range Components() {
		comps[c.ID] = c
	}
	want := map[string]string{"pandoc": "GPL-2.0-or-later", "typst": "Apache-2.0", "monolith": "CC0-1.0"}
	if len(pack.Components) != len(want) {
		t.Fatalf("components %v", pack.Components)
	}
	for _, id := range pack.Components {
		c, ok := comps[id]
		if !ok || c.License != want[id] || c.Href == "" || c.DepID == "" || c.Version == "" {
			t.Errorf("%s: %+v", id, c)
		}
		if _, ok := installerModules[c.DepID]; !ok {
			t.Errorf("%s has no installer module", id)
		}
		if _, ok := c.Sizes[MacIntel]; ok {
			t.Errorf("%s has an Intel Mac size but no asset", id)
		}
	}
	for _, key := range []string{Windows, MacARM} {
		var total int64
		for _, id := range pack.Components {
			total += comps[id].Sizes[key].Download
		}
		if total < 60_000_000 || total > 72_000_000 {
			t.Errorf("%s download %d bytes, want 64 MB (Mac) to 71 MB (Windows)", key, total)
		}
	}
	mods := map[string]bool{}
	for _, u := range pack.Unlocks {
		mods[u.Module] = true
	}
	if !mods["documents"] || !mods["archiver"] || len(mods) != 2 {
		t.Errorf("unlocks %+v", pack.Unlocks)
	}
}
