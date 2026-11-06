package lan

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func newIdentity(t *testing.T) *Identity {
	t.Helper()
	id, err := LoadOrCreateIdentity(t.TempDir(), "peer")
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func (h *harness) addPaired(id *Identity, auto bool) {
	h.rt.mu.Lock()
	h.rt.devs[id.Fingerprint] = &Device{Fingerprint: id.Fingerprint, Alias: "Paired peer", Toolbox: true, Paired: true, AutoAccept: auto, Stored: true, Address: "127.0.0.1", Port: 1}
	h.rt.mu.Unlock()
}

func sha(s string) *string {
	sum := sha256.Sum256([]byte(s))
	return ptr(hex.EncodeToString(sum[:]))
}

// putFile sends one file's bytes and returns the status.
func putFile(t *testing.T, h *harness, c *http.Client, sid, fid, tok, data string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, uploadURL(h, sid, fid, tok), strings.NewReader(data))
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func prepare(t *testing.T, h *harness, c *http.Client, pin string, req prepareRequest) (int, []byte) {
	t.Helper()
	u := h.url(APIBase + "/prepare-upload")
	if pin != "" {
		u += "?pin=" + pin
	}
	return post(t, c, u, req)
}

func TestPrepareAcceptUploadDone(t *testing.T) {
	h := newHarness(t)
	h.listen()
	h.answerPrompts(true, false)
	c := httpClient(nil)
	files := []tf{{name: "Trip/a.txt", data: "hello"}, {name: "b.bin", data: "0123456789", sha: sha("0123456789")}}
	code, body := prepare(t, h, c, "", prepBody("Nice Orange", "5f", files...))
	if code != 200 {
		t.Fatalf("prepare = %d %s", code, body)
	}
	resp := decodePrepare(t, body)
	if len(resp.Files) != 2 {
		t.Fatalf("tokens: %v", resp.Files)
	}
	for _, tok := range resp.Files {
		if len(tok) != 32 {
			t.Errorf("token %q isn't 128 bits of hex", tok)
		}
	}
	for i, f := range files {
		id := "id" + itoa(i)
		if got := putFile(t, h, c, resp.SessionID, id, resp.Files[id], f.data); got != 200 {
			t.Fatalf("upload %s = %d", f.name, got)
		}
	}
	if err := <-h.sinkErr; err != nil {
		t.Fatalf("sink: %v", err)
	}
	if got := readFile(t, h.recv+"/Nice Orange/Trip/a.txt"); got != "hello" {
		t.Errorf("a.txt = %q", got)
	}
	if got := readFile(t, h.recv+"/Nice Orange/b.bin"); got != "0123456789" {
		t.Errorf("b.bin = %q", got)
	}
	// The slot is free again.
	waitFor(t, "session release", func() bool { h.rt.mu.Lock(); defer h.rt.mu.Unlock(); return !h.rt.busy && h.rt.session == nil })
	p := h.eventsNamed(EventPrompt)[0].(Prompt)
	if p.Kind != PromptTransfer || p.Verified || p.CanAlways || p.FileCount != 2 || p.TotalBytes != 15 {
		t.Errorf("prompt = %+v", p)
	}
	if closed := h.eventsNamed(EventPromptClose); len(closed) != 1 || closed[0].(PromptClosed).Reason != "accepted" {
		t.Errorf("prompt close events: %v", closed)
	}
}

func TestTextOnlyMessages(t *testing.T) {
	text := tf{name: "note.txt", data: "hello there", typ: "text/plain", preview: ptr("hello there")}
	t.Run("unverified is asked, accepted gives 204 and a message", func(t *testing.T) {
		h := newHarness(t)
		h.listen()
		h.answerPrompts(true, false)
		code, _ := prepare(t, h, httpClient(nil), "", prepBody("Phone", "ab", text))
		if code != 204 {
			t.Fatalf("code = %d", code)
		}
		msgs := h.rt.Messages()
		if len(msgs) != 1 || msgs[0].Text != "hello there" || msgs[0].From.Alias != "Phone" {
			t.Errorf("messages = %+v", msgs)
		}
		if got := h.eventsNamed(EventMessage); len(got) != 1 {
			t.Errorf("message events = %d", len(got))
		}
		if p := h.eventsNamed(EventPrompt)[0].(Prompt); p.Kind != PromptMessage || p.Text != "hello there" {
			t.Errorf("prompt = %+v", p)
		}
		h.rt.ClearMessages()
		if len(h.rt.Messages()) != 0 {
			t.Error("ClearMessages")
		}
	})
	t.Run("declined gives 403", func(t *testing.T) {
		h := newHarness(t)
		h.listen()
		h.answerPrompts(false, false)
		code, _ := prepare(t, h, httpClient(nil), "", prepBody("Phone", "ab", text))
		if code != 403 || len(h.rt.Messages()) != 0 {
			t.Errorf("code = %d, messages %v", code, h.rt.Messages())
		}
	})
	t.Run("trusted auto-accept shows no prompt", func(t *testing.T) {
		h := newHarness(t)
		h.listen()
		peer := newIdentity(t)
		h.addPaired(peer, true)
		code, _ := prepare(t, h, httpClient(&peer.Cert), "", prepBody("x", "y", text))
		if code != 204 || len(h.eventsNamed(EventPrompt)) != 0 || len(h.rt.Messages()) != 1 {
			t.Errorf("code %d, prompts %d, messages %d", code, len(h.eventsNamed(EventPrompt)), len(h.rt.Messages()))
		}
	})
	t.Run("big or empty previews are files, not messages", func(t *testing.T) {
		big := map[string]wireFile{"a": {ID: "a", FileName: "a.txt", Size: MaxTextBytes + 1, FileType: "text/plain", Preview: ptr("x")}}
		empty := map[string]wireFile{"a": {ID: "a", FileName: "a.txt", Size: 1, FileType: "text/plain", Preview: ptr("")}}
		if isTextOnly(big) || isTextOnly(empty) || isTextOnly(nil) {
			t.Error("not text only")
		}
	})
}

func TestMineOnly(t *testing.T) {
	h := newHarness(t)
	h.listen()
	if err := h.rt.SetSettings(Settings{From: FromMine}); err != nil {
		t.Fatal(err)
	}
	code, _ := prepare(t, h, httpClient(nil), "", prepBody("LocalSend phone", "ab", tf{name: "a", data: "x"}))
	if code != 403 {
		t.Fatalf("unverified sender = %d", code)
	}
	if len(h.eventsNamed(EventPrompt)) != 0 {
		t.Error("nothing may be shown to the user")
	}
	acts := h.rt.Activity()
	if len(acts) != 1 || acts[0].Text != "Turned away a transfer from LocalSend phone (not one of your devices)" {
		t.Errorf("activity = %+v", acts)
	}
	// A verified but unpaired Toolbox is also turned away.
	unpaired := newIdentity(t)
	if code, _ := prepare(t, h, httpClient(&unpaired.Cert), "", prepBody("x", "y", tf{name: "a", data: "x"})); code != 403 {
		t.Errorf("verified unpaired = %d", code)
	}
	// A verified paired one gets in (and is asked).
	paired := newIdentity(t)
	h.addPaired(paired, false)
	h.answerPrompts(true, false)
	if code, _ := prepare(t, h, httpClient(&paired.Cert), "", prepBody("x", "y", tf{name: "a", data: "x"})); code != 200 {
		t.Errorf("verified paired = %d", code)
	}
}

func TestPINAndLockout(t *testing.T) {
	h := newHarness(t)
	h.listen()
	if err := h.rt.SetSettings(Settings{From: FromAnyone, PIN: "1234"}); err != nil {
		t.Fatal(err)
	}
	h.answerPrompts(false, false) // reaching the prompt is enough; declined => 403
	c := httpClient(nil)
	req := prepBody("Phone", "ab", tf{name: "a", data: "x"})
	if code, _ := prepare(t, h, c, "", req); code != 401 {
		t.Errorf("missing pin = %d", code)
	}
	for i := 1; i <= 5; i++ {
		h.clock.Advance(7 * time.Second) // stay clear of the per-minute prepare limit
		if code, _ := prepare(t, h, c, "0000", req); code != 401 {
			t.Fatalf("wrong pin #%d = %d", i, code)
		}
	}
	h.clock.Advance(7 * time.Second)
	if code, _ := prepare(t, h, c, "1234", req); code != 403 {
		t.Errorf("locked out with the right pin = %d, want 403", code)
	}
	h.clock.Advance(pinLockout + time.Second)
	if code, _ := prepare(t, h, c, "1234", req); code != 403 { // right PIN: now reaches the (declining) prompt
		t.Errorf("after lockout, right pin should reach the prompt (403 declined), got %d", code)
	}
	if len(h.eventsNamed(EventPrompt)) != 1 {
		t.Errorf("prompts shown = %d, want exactly the one after the lockout", len(h.eventsNamed(EventPrompt)))
	}
	// A verified paired device doesn't need the PIN.
	paired := newIdentity(t)
	h.addPaired(paired, true)
	h.setOnPrompt(nil)
	h.clock.Advance(time.Minute)
	if code, _ := prepare(t, h, httpClient(&paired.Cert), "", req); code != 200 {
		t.Errorf("paired device without pin = %d", code)
	}
}

func TestFreeSpace(t *testing.T) {
	var free uint64 = 1 << 30
	h := newHarness(t, func(c *Config) {
		c.ReceiveDir = func() string { return "/does/not/exist/Received" }
		c.FreeSpace = func(dir string) (uint64, error) { return free, nil }
	})
	h.listen()
	h.answerPrompts(true, false)
	c := httpClient(nil)
	big := prepareRequest{Info: Info{Alias: "Phone", Fingerprint: "ab"}, Files: map[string]wireFile{"a": {ID: "a", FileName: "big.iso", Size: 700 << 20, FileType: "x/y"}}}
	code, body := prepare(t, h, c, "", big)
	if code != 403 {
		t.Fatalf("code = %d", code)
	}
	var eb errorBody
	json.Unmarshal(body, &eb)
	if eb.Error != reasonSpace {
		t.Errorf("body = %s", body)
	}
	acts := h.rt.Activity()
	if len(acts) != 1 || !strings.Contains(acts[0].Text, "Phone") || !strings.Contains(acts[0].Text, "1.2 GB") {
		t.Errorf("activity = %+v", acts)
	}
	if len(h.eventsNamed(EventPrompt)) != 0 {
		t.Error("no prompt when there's no space")
	}
	small := prepBody("Phone", "ab", tf{name: "ok.txt", data: "x"})
	if code, _ := prepare(t, h, c, "", small); code != 200 {
		t.Errorf("small file with room = %d", code)
	}
}

func TestBusyAndRateLimit(t *testing.T) {
	t.Run("409 while a prompt is open", func(t *testing.T) {
		h := newHarness(t)
		h.listen()
		got := make(chan Prompt, 1)
		h.setOnPrompt(func(p Prompt) { got <- p }) // leave it open
		c := httpClient(nil)
		done := make(chan int, 1)
		go func() {
			code, _ := prepare(t, h, c, "", prepBody("A", "ab", tf{name: "a", data: "x"}))
			done <- code
		}()
		p := <-got
		if code, _ := prepare(t, h, httpClient(nil), "", prepBody("B", "cd", tf{name: "b", data: "y"})); code != 409 {
			t.Errorf("second prepare = %d, want 409", code)
		}
		h.rt.Respond(p.ID, false, false)
		if code := <-done; code != 403 {
			t.Errorf("declined = %d", code)
		}
	})
	t.Run("409 while a session is receiving", func(t *testing.T) {
		h := newHarness(t)
		h.listen()
		h.answerPrompts(true, false)
		c := httpClient(nil)
		code, body := prepare(t, h, c, "", prepBody("A", "ab", tf{name: "a", data: "x"}))
		if code != 200 {
			t.Fatal(code)
		}
		if code, _ := prepare(t, h, c, "", prepBody("B", "cd", tf{name: "b", data: "y"})); code != 409 {
			t.Errorf("second prepare = %d, want 409", code)
		}
		sid := decodePrepare(t, body).SessionID
		post(t, c, h.url(APIBase+"/cancel?sessionId="+sid), nil)
		<-h.sinkErr
	})
	t.Run("429 after ten prepares in a minute", func(t *testing.T) {
		h := newHarness(t)
		h.listen()
		c := httpClient(nil)
		bad := prepareRequest{} // 400s cost nothing but count
		var last int
		for i := 0; i < 11; i++ {
			last, _ = prepare(t, h, c, "", bad)
			if i < 10 && last != 400 {
				t.Fatalf("prepare #%d = %d", i+1, last)
			}
			h.clock.Advance(100 * time.Millisecond) // stay under 20 requests per second
		}
		if last != 429 {
			t.Errorf("11th prepare = %d, want 429", last)
		}
		h.clock.Advance(time.Minute)
		if code, _ := prepare(t, h, c, "", bad); code != 400 {
			t.Errorf("after a minute = %d", code)
		}
	})
	t.Run("429 above 20 requests per second", func(t *testing.T) {
		h := newHarness(t)
		h.listen()
		c := httpClient(nil)
		var limited bool
		for i := 0; i < 30; i++ {
			resp, err := c.Get(h.url(APIBase + "/info"))
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode == 429 {
				limited = true
			}
		}
		if !limited {
			t.Error("30 instant requests were never limited")
		}
	})
}

func TestBadRequests(t *testing.T) {
	h := newHarness(t)
	h.listen()
	c := httpClient(nil)
	cases := map[string]prepareRequest{
		"no files":    prepareRequest{Info: Info{Alias: "A"}},
		"traversal":   prepBody("A", "ab", tf{name: "../../evil.txt", data: "x"}),
		"dot":         prepBody("A", "ab", tf{name: "a/./b", data: "x"}),
		"long name":   prepBody("A", "ab", tf{name: strings.Repeat("n", 300), data: "x"}),
		"deep":        prepBody("A", "ab", tf{name: strings.Repeat("d/", 20) + "f", data: "x"}),
		"negative":    prepareRequest{Files: map[string]wireFile{"a": {ID: "a", FileName: "a", Size: -5}}},
		"bad sha hex": prepBody("A", "ab", tf{name: "a", data: "x", sha: ptr("nothex")}),
	}
	for name, body := range cases {
		h.clock.Advance(7 * time.Second)
		if code, _ := prepare(t, h, c, "", body); code != 400 {
			t.Errorf("%s: got %d, want 400", name, code)
		}
	}
	if resp, err := c.Get(h.url("/nothing")); err != nil || resp.StatusCode != 404 {
		t.Errorf("unknown route: %v %v", resp, err)
	}
	for _, p := range []string{"/api/localsend/v2/download", "/api/localsend/v2/show", "/"} {
		resp, err := c.Get(h.url(p))
		if err != nil || resp.StatusCode != 404 {
			t.Errorf("%s: %v %v", p, resp, err)
		}
	}
	resp, _ := c.Get(h.url(APIBase + "/prepare-upload"))
	if resp.StatusCode != 404 {
		t.Errorf("GET prepare-upload = %d", resp.StatusCode)
	}
}

func TestRawBadBodies(t *testing.T) {
	h := newHarness(t)
	h.listen()
	c := httpClient(nil)
	for name, body := range map[string]any{
		"not json": []byte("{nope"),
		"oversize": strings.NewReader(`{"info":{},"files":{},"pad":"` + strings.Repeat("x", MaxJSONBytes+10) + `"}`),
	} {
		h.clock.Advance(7 * time.Second)
		if code, _ := post(t, c, h.url(APIBase+"/prepare-upload"), body); code != 400 {
			t.Errorf("%s: %d", name, code)
		}
		if code, _ := post(t, c, h.url(APIBase+"/register"), body); code != 400 {
			t.Errorf("register %s: %d", name, code)
		}
	}
}

func TestUploadChecks(t *testing.T) {
	setup := func(t *testing.T, files ...tf) (*harness, *http.Client, prepareResponse) {
		h := newHarness(t)
		h.listen()
		h.answerPrompts(true, false)
		c := httpClient(nil)
		code, body := prepare(t, h, c, "", prepBody("Phone", "ab", files...))
		if code != 200 {
			t.Fatalf("prepare = %d", code)
		}
		return h, c, decodePrepare(t, body)
	}
	t.Run("missing parameters", func(t *testing.T) {
		h, c, _ := setup(t, tf{name: "a", data: "x"})
		code, _ := post(t, c, h.url(APIBase+"/upload?sessionId=x"), strings.NewReader("x"))
		if code != 400 {
			t.Errorf("code = %d", code)
		}
	})
	t.Run("bad token", func(t *testing.T) {
		h, c, r := setup(t, tf{name: "a", data: "x"})
		if code := putFile(t, h, c, r.SessionID, "id0", strings.Repeat("0", 32), "x"); code != 403 {
			t.Errorf("code = %d", code)
		}
		if code := putFile(t, h, c, r.SessionID, "nope", r.Files["id0"], "x"); code != 403 {
			t.Errorf("unknown file = %d", code)
		}
	})
	t.Run("session gone", func(t *testing.T) {
		h, c, r := setup(t, tf{name: "a", data: "x"})
		if code := putFile(t, h, c, "other-session", "id0", r.Files["id0"], "x"); code != 409 {
			t.Errorf("code = %d", code)
		}
	})
	t.Run("another IP is refused", func(t *testing.T) {
		h := newHarness(t)
		h.rt.ipHook = func(ip, hdr string) string {
			if hdr != "" {
				return hdr
			}
			return ip
		}
		h.listen()
		h.answerPrompts(true, false)
		c := httpClient(nil)
		code, body := prepare(t, h, c, "", prepBody("Phone", "ab", tf{name: "a", data: "x"}))
		if code != 200 {
			t.Fatal(code)
		}
		r := decodePrepare(t, body)
		req, _ := http.NewRequest(http.MethodPost, uploadURL(h, r.SessionID, "id0", r.Files["id0"]), strings.NewReader("x"))
		req.Header.Set("X-Test-IP", "192.168.9.9")
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 403 {
			t.Errorf("other IP upload = %d, want 403", resp.StatusCode)
		}
		// ...and it can't cancel the session either.
		creq, _ := http.NewRequest(http.MethodPost, h.url(APIBase+"/cancel?sessionId="+r.SessionID), nil)
		creq.Header.Set("X-Test-IP", "192.168.9.9")
		cresp, _ := c.Do(creq)
		cresp.Body.Close()
		if cresp.StatusCode != 403 {
			t.Errorf("other IP cancel = %d", cresp.StatusCode)
		}
		if code := putFile(t, h, c, r.SessionID, "id0", r.Files["id0"], "x"); code != 200 {
			t.Errorf("the real sender can still upload: %d", code)
		}
		<-h.sinkErr
	})
	t.Run("size mismatch is 422 and the file can be retried", func(t *testing.T) {
		h, c, r := setup(t, tf{name: "a", data: "12345"})
		if code := putFile(t, h, c, r.SessionID, "id0", r.Files["id0"], "123"); code != 422 {
			t.Errorf("short = %d", code)
		}
		if code := putFile(t, h, c, r.SessionID, "id0", r.Files["id0"], "1234567"); code != 422 {
			t.Errorf("long = %d", code)
		}
		if code := putFile(t, h, c, r.SessionID, "id0", r.Files["id0"], "12345"); code != 200 {
			t.Errorf("retry = %d", code)
		}
		if err := <-h.sinkErr; err != nil {
			t.Errorf("sink: %v", err)
		}
		if got := readFile(t, h.recv+"/Phone/a"); got != "12345" {
			t.Errorf("a = %q", got)
		}
	})
	t.Run("sha mismatch is 422", func(t *testing.T) {
		h, c, r := setup(t, tf{name: "a", data: "hello", sha: sha("something else")})
		if code := putFile(t, h, c, r.SessionID, "id0", r.Files["id0"], "hello"); code != 422 {
			t.Errorf("code = %d", code)
		}
		post(t, c, h.url(APIBase+"/cancel?sessionId="+r.SessionID), nil)
		<-h.sinkErr
		if fileExists(h.recv + "/Phone/a") {
			t.Error("a corrupt file must not be left behind")
		}
	})
	t.Run("cancel ends the session", func(t *testing.T) {
		h, c, r := setup(t, tf{name: "a", data: "x"}, tf{name: "b", data: "y"})
		if code, _ := post(t, c, h.url(APIBase+"/cancel?sessionId="+r.SessionID), nil); code != 200 {
			t.Errorf("cancel = %d", code)
		}
		if err := <-h.sinkErr; err == nil || !strings.Contains(err.Error(), "cancelled") {
			t.Errorf("sink saw %v", err)
		}
		if code := putFile(t, h, c, r.SessionID, "id0", r.Files["id0"], "x"); code != 409 {
			t.Errorf("upload after cancel = %d", code)
		}
		waitFor(t, "slot freed", func() bool { h.rt.mu.Lock(); defer h.rt.mu.Unlock(); return !h.rt.busy })
	})
	t.Run("a stalled upload times out the session", func(t *testing.T) {
		old := uploadIdle
		uploadIdle = 200 * time.Millisecond
		defer func() { uploadIdle = old }()
		h, c, r := setup(t, tf{name: "a", data: "0123456789"})
		pr, pw := io.Pipe()
		go func() { pw.Write([]byte("0123")) }() // then silence
		req, _ := http.NewRequest(http.MethodPost, uploadURL(h, r.SessionID, "id0", r.Files["id0"]), pr)
		req.ContentLength = 10
		resp, err := c.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		pw.Close()
		if err := <-h.sinkErr; err == nil {
			t.Error("the session should have failed")
		}
		waitFor(t, "slot freed", func() bool { h.rt.mu.Lock(); defer h.rt.mu.Unlock(); return !h.rt.busy })
	})
}

func TestPromptTimeout(t *testing.T) {
	old := promptTimeout
	promptTimeout = 80 * time.Millisecond
	defer func() { promptTimeout = old }()
	h := newHarness(t)
	h.listen()
	code, _ := prepare(t, h, httpClient(nil), "", prepBody("Phone", "ab", tf{name: "a", data: "x"}))
	if code != 403 {
		t.Errorf("timeout = %d, want 403", code)
	}
	closed := h.eventsNamed(EventPromptClose)
	if len(closed) != 1 || closed[0].(PromptClosed).Reason != "timeout" {
		t.Errorf("close events = %v", closed)
	}
	if err := h.rt.Respond("gone", true, false); err == nil {
		t.Error("answering an unknown prompt should fail")
	}
	waitFor(t, "slot freed", func() bool { h.rt.mu.Lock(); defer h.rt.mu.Unlock(); return !h.rt.busy })
}

func TestVerifiedVersusUnverified(t *testing.T) {
	h := newHarness(t)
	h.listen()
	files := tf{name: "a", data: "x"}
	var prompts []Prompt
	h.setOnPrompt(func(p Prompt) {
		prompts = append(prompts, p)
		h.rt.Respond(p.ID, false, false)
	})
	peer := newIdentity(t)

	// Unverified claiming a paired device's fingerprint gets no trust.
	h.addPaired(peer, true)
	prepare(t, h, httpClient(nil), "", prepBody("Impostor", peer.Fingerprint, files))
	if len(prompts) != 1 || prompts[0].Verified || prompts[0].Device.Paired || prompts[0].CanAlways {
		t.Fatalf("claimed fingerprint without a certificate must prompt as unverified: %+v", prompts)
	}
	// Verified + paired + auto-accept: no prompt, accepted.
	h.clock.Advance(10 * time.Second)
	h.setOnPrompt(nil)
	code, body := prepare(t, h, httpClient(&peer.Cert), "", prepBody("Anything", "wrong-claim", files))
	if code != 200 {
		t.Fatalf("auto-accept = %d", code)
	}
	r := decodePrepare(t, body)
	putFile(t, h, httpClient(nil), r.SessionID, "id0", r.Files["id0"], "x")
	<-h.sinkErr
	if got := readFile(t, h.recv+"/Paired peer/a"); got != "x" {
		t.Errorf("file = %q (the stored alias names the folder, not the claim)", got)
	}
	// Verified + paired, auto-accept off: asks, and offers "always".
	h.rt.SetAutoAccept(peer.Fingerprint, false)
	prompts = nil
	h.setOnPrompt(func(p Prompt) {
		prompts = append(prompts, p)
		h.rt.Respond(p.ID, false, false)
	})
	h.clock.Advance(10 * time.Second)
	prepare(t, h, httpClient(&peer.Cert), "", prepBody("Anything", "x", files))
	if len(prompts) != 1 || !prompts[0].Verified || !prompts[0].CanAlways {
		t.Errorf("paired without auto-accept: %+v", prompts)
	}
	// Verified, never paired: asks, no "always".
	stranger := newIdentity(t)
	prompts = nil
	h.clock.Advance(10 * time.Second)
	prepare(t, h, httpClient(&stranger.Cert), "", prepBody("Stranger", "x", files))
	if len(prompts) != 1 || !prompts[0].Verified || prompts[0].CanAlways || prompts[0].Device.Fingerprint != stranger.Fingerprint {
		t.Errorf("verified stranger: %+v", prompts)
	}
}

func TestAlwaysAcceptFromPrompt(t *testing.T) {
	h := newHarness(t)
	h.listen()
	peer := newIdentity(t)
	h.addPaired(peer, false)
	h.answerPrompts(true, true)
	code, body := prepare(t, h, httpClient(&peer.Cert), "", prepBody("x", "y", tf{name: "a", data: "x"}))
	if code != 200 {
		t.Fatal(code)
	}
	r := decodePrepare(t, body)
	putFile(t, h, httpClient(nil), r.SessionID, "id0", r.Files["id0"], "x")
	<-h.sinkErr
	d, _ := h.rt.Device(peer.Fingerprint)
	if !d.AutoAccept {
		t.Error("accepting with 'always' should turn on auto-accept")
	}
}

func TestRegisterAndInfo(t *testing.T) {
	h := newHarness(t)
	h.listen()
	c := httpClient(nil)
	info := Info{Alias: "Nice Orange", Version: "2.0", DeviceType: "mobile", Fingerprint: "ABCDEF", Port: 4000, Protocol: "https", Announce: true}
	code, body := post(t, c, h.url(APIBase+"/register"), info)
	if code != 200 {
		t.Fatalf("register = %d", code)
	}
	var self Info
	json.Unmarshal(body, &self)
	if self.Fingerprint != h.rt.Fingerprint() || self.Toolbox != 1 || self.Protocol != "https" || self.Alias != "test-host" || self.Port != h.rt.State().Port {
		t.Errorf("self info = %+v", self)
	}
	devs := h.rt.Devices()
	if len(devs) != 1 || devs[0].Fingerprint != "abcdef" || devs[0].Address != "127.0.0.1" || devs[0].Port != 4000 || devs[0].Stored || !devs[0].Online || devs[0].Toolbox {
		t.Errorf("devices = %+v", devs)
	}
	if got := h.eventsNamed(EventDevices); len(got) == 0 {
		t.Error("no devices event")
	}
	resp, err := c.Get(h.url(APIBase + "/info"))
	if err != nil || resp.StatusCode != 200 {
		t.Errorf("info: %v %v", resp, err)
	}
	if resp.TLS.Version < tls.VersionTLS12 {
		t.Error("TLS below 1.2")
	}
	// TLS 1.1 is refused.
	old := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true, MaxVersion: tls.VersionTLS11}}}
	if r, err := old.Get(h.url(APIBase + "/info")); err == nil {
		r.Body.Close()
		t.Error("TLS 1.1 must be refused")
	}
	// Plain HTTP gets nothing useful.
	if r, err := http.Get(strings.Replace(h.url("/"), "https", "http", 1)); err == nil && r.StatusCode == 200 {
		t.Error("plain HTTP must not be served")
	}
}

func TestRegisterDoesNotMoveStoredDevices(t *testing.T) {
	h := newHarness(t)
	h.listen()
	peer := newIdentity(t)
	h.addPaired(peer, false)
	c := httpClient(nil)
	// An unverified claim for a stored device's fingerprint changes nothing.
	post(t, c, h.url(APIBase+"/register"), Info{Alias: "Evil", Fingerprint: peer.Fingerprint, Port: 9999, Protocol: "https"})
	d, _ := h.rt.Device(peer.Fingerprint)
	if d.Alias != "Paired peer" || d.Port != 1 {
		t.Errorf("stored device moved by an unverified claim: %+v", d)
	}
	// A verified one (it presents the certificate) updates it.
	post(t, httpClient(&peer.Cert), h.url(APIBase+"/register"), Info{Alias: "Renamed", Fingerprint: "ignored", Port: 7777, Protocol: "https", Toolbox: 1})
	d, _ = h.rt.Device(peer.Fingerprint)
	if d.Alias != "Renamed" || d.Port != 7777 || !d.Paired {
		t.Errorf("verified update: %+v", d)
	}
}

func TestMultiFileTokensAreDistinct(t *testing.T) {
	h := newHarness(t)
	h.listen()
	h.answerPrompts(true, false)
	code, body := prepare(t, h, httpClient(nil), "", prepBody("P", "ab", tf{name: "a", data: "1"}, tf{name: "b", data: "2"}, tf{name: "c", data: "3"}))
	if code != 200 {
		t.Fatal(code)
	}
	r := decodePrepare(t, body)
	seen := map[string]bool{r.SessionID: true}
	for _, tok := range r.Files {
		if seen[tok] {
			t.Error("duplicate token")
		}
		seen[tok] = true
	}
	post(t, httpClient(nil), h.url(APIBase+"/cancel?sessionId="+r.SessionID), nil)
	<-h.sinkErr
}
