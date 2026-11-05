package enroll

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
)

// The device key is the host's proof of possession on the link: an Ed25519
// key pair whose public half openedbot learns in `hello` and whose private
// half never leaves this host. Linux seals the seed in a systemd credential;
// macOS stores it in the user's Keychain.

// DeviceSeedSize is the Ed25519 seed length, the only form persisted.
const DeviceSeedSize = ed25519.SeedSize

// PoPNonceSize is the broker challenge length.
const PoPNonceSize = 32

// popPrefix separates the proof of possession from every other signature a
// key could be asked for.
const popPrefix = "openedbot-link-pop/v1\n"

// GenerateDeviceKey draws a fresh Ed25519 key pair.
func GenerateDeviceKey() (ed25519.PrivateKey, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return priv, nil
}

// EncodeDeviceSeed renders the credential body: the base64 seed and a
// newline. It is what systemd-creds encrypts and what the daemon reads back.
func EncodeDeviceSeed(priv ed25519.PrivateKey) []byte {
	return []byte(base64.StdEncoding.EncodeToString(priv.Seed()) + "\n")
}

// ParseDeviceSeed reads a credential body back into a private key. Raw 32
// bytes are accepted too, so a credential written by hand still loads.
func ParseDeviceSeed(data []byte) (ed25519.PrivateKey, error) {
	// Binary seeds can contain whitespace or resemble base64. Interpret their
	// exact length before applying text normalization to encoded credentials.
	if len(data) == DeviceSeedSize {
		return ed25519.NewKeyFromSeed(data), nil
	}
	trimmed := bytes.TrimSpace(data)
	seed, err := base64.StdEncoding.DecodeString(string(trimmed))
	if err != nil || len(seed) != DeviceSeedSize {
		return nil, errors.New("device key credential is not a 32-byte Ed25519 seed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// DevicePublicKey renders the public half as hello carries it.
func DevicePublicKey(priv ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
}

// ParseDevicePublicKey validates a hello devicePublicKey field.
func ParseDevicePublicKey(s string) (ed25519.PublicKey, error) {
	pub, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, errors.New("devicePublicKey is not a 32-byte base64 Ed25519 key")
	}
	return ed25519.PublicKey(pub), nil
}

// ParsePoPNonce validates a link.challenge nonce.
func ParsePoPNonce(s string) ([]byte, error) {
	nonce, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(nonce) != PoPNonceSize {
		return nil, fmt.Errorf("link.challenge nonce is not %d base64 bytes", PoPNonceSize)
	}
	return nonce, nil
}

// PoPMessage is the exact byte string both sides sign and verify:
// "openedbot-link-pop/v1\n" || nonce || "\n" || runtimeId || "\n" || wsURL || "\n".
// runtimeId is empty during enrollment (the host has none yet); wsURL is the
// URL as dialed, so a proof cannot be replayed toward another broker.
func PoPMessage(nonce []byte, runtimeID, wsURL string) []byte {
	msg := make([]byte, 0, len(popPrefix)+len(nonce)+len(runtimeID)+len(wsURL)+3)
	msg = append(msg, popPrefix...)
	msg = append(msg, nonce...)
	msg = append(msg, '\n')
	msg = append(msg, runtimeID...)
	msg = append(msg, '\n')
	msg = append(msg, wsURL...)
	msg = append(msg, '\n')
	return msg
}

// SignPoP answers a challenge; the result is the base64 link.proof signature.
func SignPoP(priv ed25519.PrivateKey, nonce []byte, runtimeID, wsURL string) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, PoPMessage(nonce, runtimeID, wsURL)))
}

// VerifyPoP is the broker side, kept here so the Go tests prove the exact
// contract the TypeScript broker implements.
func VerifyPoP(pub ed25519.PublicKey, nonce []byte, runtimeID, wsURL, signature string) bool {
	sig, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(pub, PoPMessage(nonce, runtimeID, wsURL), sig)
}
