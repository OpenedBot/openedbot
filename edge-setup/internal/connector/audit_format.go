package connector

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"unicode/utf8"
)

// The creation audit file format, version 2 (docs/CONNECTOR.md, « Audit de
// création chiffré »). Every integer is big-endian.
//
//	offset  size  field
//	0       8     magic "OBAUDIT2"
//	8       1     version 0x02
//	9       1     suite   0x01 = AES-256-GCM, HKDF-SHA256, SHA-256
//	10      2     hlen
//	12      hlen  header, canonical JSON {keyId,runtimeId,schemaVersion,writeSeq}
//	12+hlen 12    nonce
//	24+hlen n     ciphertext
//	...     16    GCM tag
//
// The associated data is every byte before the ciphertext, so a header or a
// nonce that was touched fails authentication instead of being trusted.
const (
	auditMagic         = "OBAUDIT2"
	auditVersion       = 0x02
	auditSuiteAESGCM   = 0x01
	auditSchemaVersion = 2
	auditMaxHeader     = 1024
	auditNonceSize     = 12
	auditKeySize       = 32
	auditInfoEnc       = "openedbot-creation-audit/v2/enc"
	auditGenesisPrefix = "openedbot-creation-audit/v2/genesis"
)

// Errors a verifier distinguishes. ErrAuditPlaintext names the file a
// connector older than v2 wrote: it is never read as evidence.
var (
	ErrAuditPlaintext  = errors.New("creation audit is a plaintext v1 snapshot, not evidence")
	ErrAuditFormat     = errors.New("creation audit format is invalid")
	ErrAuditKeyUnknown = errors.New("creation audit key is not available")
	ErrAuditAuth       = errors.New("creation audit authentication failed")
	ErrAuditChain      = errors.New("creation audit chain is broken")
	ErrAuditKeyMissing = errors.New("creation audit has no key: the link has not armed it")
)

// auditHeader is the clear part of the file, readable without the key.
type auditHeader struct {
	KeyID         string `json:"keyId"`
	RuntimeID     string `json:"runtimeId"`
	SchemaVersion int    `json:"schemaVersion"`
	WriteSeq      uint64 `json:"writeSeq"`
}

// deriveAuditKey turns the master key openedbot provisions into the file
// encryption key. The runtime id is the salt: the same master key can never
// seal another runtime's file.
func deriveAuditKey(master []byte, runtimeID string) ([]byte, error) {
	if len(master) != auditKeySize {
		return nil, fmt.Errorf("audit master key must be %d bytes", auditKeySize)
	}
	if runtimeID == "" {
		return nil, errors.New("audit key derivation requires a runtime id")
	}
	return hkdf.Key(sha256.New, master, []byte(runtimeID), auditInfoEnc, auditKeySize)
}

// sealSnapshot encrypts one canonical plaintext under the derived key.
func sealSnapshot(hdr auditHeader, plaintext, key []byte, random io.Reader) ([]byte, error) {
	header, err := canonicalJSON(hdr)
	if err != nil {
		return nil, err
	}
	if len(header) > auditMaxHeader {
		return nil, fmt.Errorf("%w: header of %d bytes", ErrAuditFormat, len(header))
	}
	aead, err := newAuditAEAD(key)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, 24+len(header)+len(plaintext)+aead.Overhead())
	out = append(out, auditMagic...)
	out = append(out, auditVersion, auditSuiteAESGCM)
	out = binary.BigEndian.AppendUint16(out, uint16(len(header)))
	out = append(out, header...)
	nonce := make([]byte, auditNonceSize)
	if _, err := io.ReadFull(random, nonce); err != nil {
		return nil, err
	}
	out = append(out, nonce...)
	return aead.Seal(out, nonce, plaintext, out), nil
}

// parseAuditHeader reads the clear header and returns where the nonce starts.
func parseAuditHeader(data []byte) (auditHeader, int, error) {
	if len(data) > 0 && data[0] == '{' {
		return auditHeader{}, 0, ErrAuditPlaintext
	}
	if len(data) < 12 || string(data[:8]) != auditMagic {
		return auditHeader{}, 0, fmt.Errorf("%w: missing magic", ErrAuditFormat)
	}
	if data[8] != auditVersion || data[9] != auditSuiteAESGCM {
		return auditHeader{}, 0, fmt.Errorf("%w: version %d suite %d", ErrAuditFormat, data[8], data[9])
	}
	hlen := int(binary.BigEndian.Uint16(data[10:12]))
	if hlen == 0 || hlen > auditMaxHeader || len(data) < 12+hlen+auditNonceSize+16 {
		return auditHeader{}, 0, fmt.Errorf("%w: header length %d", ErrAuditFormat, hlen)
	}
	var hdr auditHeader
	if err := json.Unmarshal(data[12:12+hlen], &hdr); err != nil {
		return auditHeader{}, 0, fmt.Errorf("%w: %v", ErrAuditFormat, err)
	}
	canonical, err := canonicalJSON(hdr)
	if err != nil || !bytes.Equal(canonical, data[12:12+hlen]) {
		return auditHeader{}, 0, fmt.Errorf("%w: header is not canonical", ErrAuditFormat)
	}
	if hdr.SchemaVersion != auditSchemaVersion || hdr.KeyID == "" || hdr.RuntimeID == "" {
		return auditHeader{}, 0, fmt.Errorf("%w: header fields", ErrAuditFormat)
	}
	return hdr, 12 + hlen, nil
}

// openSnapshot authenticates and decrypts a file. keyFor maps the header's
// key id to the MASTER key; derivation happens here with the header's
// runtime id, which the tag covers.
func openSnapshot(data []byte, keyFor func(keyID string) ([]byte, bool)) (auditHeader, []byte, error) {
	hdr, at, err := parseAuditHeader(data)
	if err != nil {
		return hdr, nil, err
	}
	master, ok := keyFor(hdr.KeyID)
	if !ok {
		return hdr, nil, fmt.Errorf("%w: %s", ErrAuditKeyUnknown, hdr.KeyID)
	}
	key, err := deriveAuditKey(master, hdr.RuntimeID)
	if err != nil {
		return hdr, nil, err
	}
	aead, err := newAuditAEAD(key)
	if err != nil {
		return hdr, nil, err
	}
	nonce := data[at : at+auditNonceSize]
	plaintext, err := aead.Open(nil, nonce, data[at+auditNonceSize:], data[:at+auditNonceSize])
	if err != nil {
		return hdr, nil, ErrAuditAuth
	}
	return hdr, plaintext, nil
}

func newAuditAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != auditKeySize {
		return nil, fmt.Errorf("audit key must be %d bytes", auditKeySize)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// auditGenesis is the chain base of a runtime that has dropped nothing yet.
func auditGenesis(runtimeID string) [32]byte {
	return sha256.Sum256([]byte(auditGenesisPrefix + runtimeID))
}

// chainNext links one canonical event to the previous hash:
// h_i = SHA-256(0x01 || canonical(e_i) || h_{i-1}).
func chainNext(prev [32]byte, canonicalEvent []byte) [32]byte {
	h := sha256.New()
	h.Write([]byte{0x01})
	h.Write(canonicalEvent)
	h.Write(prev[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func hashHex(h [32]byte) string { return hex.EncodeToString(h[:]) }

func hashFromHex(s string) ([32]byte, error) {
	var out [32]byte
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 32 {
		return out, fmt.Errorf("%w: hash %q", ErrAuditFormat, s)
	}
	copy(out[:], b)
	return out, nil
}

// canonicalJSON encodes v the way openedbot re-encodes it before
// verifying a hash: object keys sorted by UTF-16 code units, no whitespace,
// minimal string escaping (no HTML escaping, no U+2028/U+2029 escaping), integers as
// plain digits. The value is first marshalled by encoding/json so struct tags
// and omitempty apply, then re-encoded from the generic tree.
func canonicalJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := writeCanonical(&buf, tree); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		buf.WriteString(strconv.FormatBool(x))
	case json.Number:
		if _, err := strconv.ParseInt(x.String(), 10, 64); err != nil {
			return fmt.Errorf("canonical JSON allows integers only, got %s", x)
		}
		buf.WriteString(x.String())
	case string:
		writeCanonicalString(buf, x)
	case []any:
		buf.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeCanonicalString(buf, k)
			buf.WriteByte(':')
			if err := writeCanonical(buf, x[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		return fmt.Errorf("canonical JSON cannot encode %T", v)
	}
	return nil
}

// lessUTF16 orders keys by UTF-16 code units (RFC 8785), which JavaScript's
// default string comparison also uses.
func lessUTF16(a, b string) bool {
	ua, ub := utf16Units(a), utf16Units(b)
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

func utf16Units(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	}
	return out
}

func writeCanonicalString(buf *bytes.Buffer, s string) {
	const hexDigits = "0123456789abcdef"
	buf.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch c {
			case '"':
				buf.WriteString(`\"`)
			case '\\':
				buf.WriteString(`\\`)
			case '\b':
				buf.WriteString(`\b`)
			case '\f':
				buf.WriteString(`\f`)
			case '\n':
				buf.WriteString(`\n`)
			case '\r':
				buf.WriteString(`\r`)
			case '\t':
				buf.WriteString(`\t`)
			default:
				if c < 0x20 {
					buf.WriteString(`\u00`)
					buf.WriteByte(hexDigits[c>>4])
					buf.WriteByte(hexDigits[c&0xF])
				} else {
					buf.WriteByte(c)
				}
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			buf.WriteString(`�`)
		} else {
			buf.WriteString(s[i : i+size])
		}
		i += size
	}
	buf.WriteByte('"')
}
