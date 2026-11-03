package editstudio

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// synthStream builds an Annex-B stream of n access units: AUD, then SPS+PPS+IDR
// on every key-th frame, else a non-IDR slice. wide uses 4-byte start codes.
func synthStream(n, keyEvery int, wide bool) (data []byte, offsets []int64, keys []int) {
	sc := []byte{0, 0, 1}
	if wide {
		sc = []byte{0, 0, 0, 1}
	}
	var b bytes.Buffer
	nal := func(hdr byte, payload ...byte) {
		b.Write(sc)
		b.WriteByte(hdr)
		b.Write(payload)
	}
	for i := 0; i < n; i++ {
		offsets = append(offsets, int64(b.Len()))
		nal(0x09, 0xf0) // AUD
		if i%keyEvery == 0 {
			keys = append(keys, i)
			nal(0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9) // SPS: profile 100, constraints 0, level 31
			nal(0x68, 0xee, 0x3c, 0x80)             // PPS
			nal(0x65, 0x88, 0x84, 0x00, 0x10)       // IDR slice
		} else {
			nal(0x41, 0x9a, 0x24, 0x6c) // non-IDR slice
		}
	}
	return b.Bytes(), offsets, keys
}

func TestBuildIndex(t *testing.T) {
	for _, wide := range []bool{false, true} {
		name := "3-byte start codes"
		if wide {
			name = "4-byte start codes"
		}
		t.Run(name, func(t *testing.T) {
			data, offsets, keys := synthStream(25, 10, wide)
			idx, err := BuildIndex(data, 540, 960, 30)
			if err != nil {
				t.Fatal(err)
			}
			if idx.Version != 1 || idx.Frames != 25 || idx.Width != 540 || idx.Height != 960 || idx.FPS != 30 {
				t.Fatalf("header: %+v", idx)
			}
			if idx.Codec != "avc1.64001f" {
				t.Errorf("codec = %s", idx.Codec)
			}
			if !slices.Equal(idx.Keys, keys) {
				t.Errorf("keys = %v, want %v", idx.Keys, keys)
			}
			want := append(slices.Clone(offsets), int64(len(data)))
			if !slices.Equal(idx.Offsets, want) {
				t.Errorf("offsets = %v, want %v", idx.Offsets, want)
			}
			if idx.Bytes != int64(len(data)) {
				t.Errorf("bytes = %d", idx.Bytes)
			}
		})
	}
}

func TestBuildIndexMixedStartCodes(t *testing.T) {
	// A 4-byte AUD start code (as x264 writes) followed by 3-byte slice codes.
	data := []byte{
		0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x1e, 0xaa, 0, 0, 1, 0x65, 1, 2, 3,
		0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x41, 9, 9,
	}
	idx, err := BuildIndex(data, 2, 2, 30)
	if err != nil {
		t.Fatal(err)
	}
	if idx.Frames != 2 || idx.Codec != "avc1.4d401e" || !slices.Equal(idx.Keys, []int{0}) || idx.Offsets[1] != 21 {
		t.Fatalf("%+v", idx)
	}
}

func TestBuildIndexTruncatedTail(t *testing.T) {
	data, offsets, _ := synthStream(5, 10, false)
	t.Run("a lone AUD at the end is dropped", func(t *testing.T) {
		cut := append(slices.Clone(data), 0, 0, 1, 0x09, 0xf0)
		idx, err := BuildIndex(cut, 2, 2, 30)
		if err != nil {
			t.Fatal(err)
		}
		if idx.Frames != 5 || idx.Offsets[5] != int64(len(data)) {
			t.Fatalf("frames %d, last offset %d, want 5 / %d", idx.Frames, idx.Offsets[5], len(data))
		}
	})
	t.Run("a cut slice keeps its frame", func(t *testing.T) {
		cut := data[:len(data)-2]
		idx, err := BuildIndex(cut, 2, 2, 30)
		if err != nil {
			t.Fatal(err)
		}
		if idx.Frames != 5 || idx.Offsets[5] != int64(len(cut)) {
			t.Fatalf("%d frames, offsets %v", idx.Frames, idx.Offsets)
		}
	})
	t.Run("the AU before the cut is intact", func(t *testing.T) {
		idx, err := BuildIndex(data[:offsets[3]+3], 2, 2, 30) // 4th AU cut inside its start code
		if err != nil {
			t.Fatal(err)
		}
		if idx.Frames != 3 {
			t.Fatalf("frames = %d", idx.Frames)
		}
	})
}

func TestBuildIndexErrors(t *testing.T) {
	noSPS := []byte{0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x65, 1, 2, 3, 0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x41, 1}
	noAUD := []byte{0, 0, 0, 1, 0x67, 0x64, 0, 0x1f, 0, 0, 1, 0x65, 1}
	leading := append([]byte{0xff, 0xff}, synthStreamBytes()...)
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{"empty", nil, "no video frames"},
		{"no SPS", noSPS, "no SPS"},
		{"no AUD first", noAUD, "access unit delimiter"},
		{"garbage before the first AUD", leading, "access unit delimiter"},
		{"no start codes", []byte("hello world, this is not video"), "no video frames"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := BuildIndex(tc.data, 2, 2, 30)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func synthStreamBytes() []byte { d, _, _ := synthStream(3, 10, true); return d }

// The chunked reader must agree with the in-memory result wherever a chunk
// boundary falls, including inside a start code or an SPS.
func TestScanIndexChunkBoundaries(t *testing.T) {
	data, _, _ := synthStream(40, 10, true)
	want, err := BuildIndex(data, 2, 2, 30)
	if err != nil {
		t.Fatal(err)
	}
	old := indexChunkSize
	defer func() { indexChunkSize = old }()
	for _, size := range []int{1, 2, 3, 5, 7, 8, 13, 64} {
		indexChunkSize = size
		got, err := BuildIndex(data, 2, 2, 30)
		if err != nil {
			t.Fatalf("chunk %d: %v", size, err)
		}
		if got.Frames != want.Frames || got.Codec != want.Codec || !slices.Equal(got.Offsets, want.Offsets) || !slices.Equal(got.Keys, want.Keys) {
			t.Fatalf("chunk %d: %+v != %+v", size, got, want)
		}
	}
}

func TestIndexPath(t *testing.T) {
	if got := IndexPath(filepath.Join("a", "v540-30.h264")); got != filepath.Join("a", "v540-30.idx.json") {
		t.Fatal(got)
	}
}

func TestWriteIndexAndRead(t *testing.T) {
	data, _, _ := synthStream(12, 10, true)
	stream := filepath.Join(t.TempDir(), "v2-30.h264")
	if err := os.WriteFile(stream, data, 0o644); err != nil {
		t.Fatal(err)
	}
	idx, err := WriteIndex(stream, 2, 2, 30)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ReadIndex(stream)
	if err != nil {
		t.Fatal(err)
	}
	if got.Frames != 12 || !slices.Equal(got.Offsets, idx.Offsets) || got.Bytes != int64(len(data)) {
		t.Fatalf("%+v", got)
	}
	if es := readStream(stream); es == nil || es.Frames != 12 || es.Index != IndexPath(stream) {
		t.Fatalf("readStream = %+v", es)
	}
	// A stream whose size no longer matches its index is not complete.
	if err := os.WriteFile(stream, data[:len(data)-1], 0o644); err != nil {
		t.Fatal(err)
	}
	if readStream(stream) != nil {
		t.Fatal("a stream with the wrong size must not count")
	}
	if _, err := WriteIndex(filepath.Join(t.TempDir(), "missing.h264"), 2, 2, 30); err == nil {
		t.Fatal("expected an error for a missing stream")
	}
}
