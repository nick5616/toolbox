package mediaindex

import (
	"encoding/base64"
	"fmt"
	"math"
)

// fp16ToFloat32 converts an IEEE 754 half-precision value.
func fp16ToFloat32(h uint16) float32 {
	sign := uint32(h>>15) & 1
	exp := uint32(h>>10) & 0x1f
	frac := uint32(h) & 0x3ff
	var bits uint32
	switch {
	case exp == 0 && frac == 0:
		bits = sign << 31
	case exp == 0: // subnormal: normalise
		e := uint32(127 - 15 + 1)
		for frac&0x400 == 0 {
			frac <<= 1
			e--
		}
		frac &= 0x3ff
		bits = sign<<31 | e<<23 | frac<<13
	case exp == 0x1f: // inf / NaN
		bits = sign<<31 | 0xff<<23 | frac<<13
	default:
		bits = sign<<31 | (exp+127-15)<<23 | frac<<13
	}
	return math.Float32frombits(bits)
}

// decodeVector turns base64 little-endian float16 into float32; "" gives nil.
func decodeVector(b64 string, dim int) ([]float32, error) {
	if b64 == "" {
		return nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("decode vector: %w", err)
	}
	if len(raw) != dim*2 {
		return nil, fmt.Errorf("vector has %d bytes, want %d", len(raw), dim*2)
	}
	out := make([]float32, dim)
	for i := range out {
		out[i] = fp16ToFloat32(uint16(raw[2*i]) | uint16(raw[2*i+1])<<8)
	}
	return out, nil
}
