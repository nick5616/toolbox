package lan

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Identity is this install's self-signed certificate. Peers pin its fingerprint.
type Identity struct {
	Cert        tls.Certificate
	Fingerprint string // lowercase hex SHA-256 of the certificate DER
}

// Fingerprint is the lowercase hex SHA-256 of a certificate's DER bytes
// (how LocalSend defines a device fingerprint in HTTPS mode).
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

// normFP lowercases and trims a fingerprint for comparison.
func normFP(fp string) string { return strings.ToLower(strings.TrimSpace(fp)) }

// ShortCode is the first 4 hex characters of a fingerprint, upper-case ("4F2A").
func ShortCode(fp string) string {
	fp = strings.ToUpper(strings.TrimSpace(fp))
	if len(fp) > 4 {
		fp = fp[:4]
	}
	return fp
}

// PairCode is the 6-digit code two fingerprints share: SHA-256 of the sorted
// fingerprints joined by "|", the first 4 bytes as a big-endian uint32, mod 1e6.
func PairCode(fpA, fpB string) string {
	pair := []string{normFP(fpA), normFP(fpB)}
	sort.Strings(pair)
	sum := sha256.Sum256([]byte(pair[0] + "|" + pair[1]))
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(sum[:4])%1000000)
}

// LoadOrCreateIdentity reads dir/identity.pem, or creates it (CN = alias).
func LoadOrCreateIdentity(dir, alias string) (*Identity, error) {
	path := filepath.Join(dir, "identity.pem")
	if data, err := os.ReadFile(path); err == nil {
		if id, err := parseIdentity(data); err == nil {
			return id, nil
		}
		// A corrupt file is replaced; pairings made with it are lost.
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("reading identity: %w", err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generating key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return nil, fmt.Errorf("serial: %w", err)
	}
	if alias == "" {
		alias = "Toolbox"
	}
	now := time.Now()
	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: alias},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("creating certificate: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("encoding key: %w", err)
	}
	var buf []byte
	buf = append(buf, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
	buf = append(buf, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})...)
	if err := writeFileAtomic(path, buf, 0o600); err != nil {
		return nil, err
	}
	return parseIdentity(buf)
}

func parseIdentity(data []byte) (*Identity, error) {
	cert, err := tls.X509KeyPair(data, data)
	if err != nil {
		return nil, fmt.Errorf("parsing identity: %w", err)
	}
	if len(cert.Certificate) == 0 {
		return nil, errors.New("identity has no certificate")
	}
	return &Identity{Cert: cert, Fingerprint: Fingerprint(cert.Certificate[0])}, nil
}

// writeFileAtomic writes to a temp file in the same directory, then renames.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	f, err := os.CreateTemp(dir, filepath.Base(path)+".tmp*")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	tmp := f.Name()
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("closing %s: %w", tmp, err)
	}
	_ = os.Chmod(tmp, perm)
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	return nil
}
