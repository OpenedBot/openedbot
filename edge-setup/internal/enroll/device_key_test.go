package enroll

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"testing"
)

func TestDeviceSeedRoundTripAndPublicKey(t *testing.T) {
	priv, err := GenerateDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	body := EncodeDeviceSeed(priv)
	if !bytes.HasSuffix(body, []byte("\n")) || len(bytes.TrimSpace(body)) != 44 {
		t.Fatalf("credential body %q", body)
	}
	back, err := ParseDeviceSeed(body)
	if err != nil || !back.Equal(priv) {
		t.Fatalf("parse: %v", err)
	}
	raw, err := ParseDeviceSeed(priv.Seed())
	if err != nil || !raw.Equal(priv) {
		t.Fatalf("raw seed: %v", err)
	}
	pub, err := ParseDevicePublicKey(DevicePublicKey(priv))
	if err != nil || !pub.Equal(priv.Public().(ed25519.PublicKey)) {
		t.Fatalf("public key: %v", err)
	}
	for _, bad := range []string{"", "AAAA", base64.StdEncoding.EncodeToString(make([]byte, 31)), "not base64!"} {
		if _, err := ParseDeviceSeed([]byte(bad)); err == nil {
			t.Errorf("seed %q accepted", bad)
		}
		if _, err := ParseDevicePublicKey(bad); err == nil {
			t.Errorf("public key %q accepted", bad)
		}
	}
}

func TestPoPMessageIsExactAndBoundToNonceRuntimeAndURL(t *testing.T) {
	priv, _ := GenerateDeviceKey()
	pub := priv.Public().(ed25519.PublicKey)
	nonce := bytes.Repeat([]byte{7}, PoPNonceSize)
	want := append([]byte("ohb-link-pop/v1\n"), nonce...)
	want = append(want, []byte("\nrt-1\nwss://ohb.example/api/runtime-links/ws\n")...)
	if got := PoPMessage(nonce, "rt-1", "wss://ohb.example/api/runtime-links/ws"); !bytes.Equal(got, want) {
		t.Fatalf("message %q", got)
	}
	sig := SignPoP(priv, nonce, "rt-1", "wss://ohb.example/api/runtime-links/ws")
	if !VerifyPoP(pub, nonce, "rt-1", "wss://ohb.example/api/runtime-links/ws", sig) {
		t.Fatal("valid proof refused")
	}
	other := bytes.Repeat([]byte{8}, PoPNonceSize)
	if VerifyPoP(pub, other, "rt-1", "wss://ohb.example/api/runtime-links/ws", sig) {
		t.Fatal("proof accepted under another nonce")
	}
	if VerifyPoP(pub, nonce, "rt-2", "wss://ohb.example/api/runtime-links/ws", sig) {
		t.Fatal("proof accepted for another runtime")
	}
	if VerifyPoP(pub, nonce, "rt-1", "wss://evil.example/api/runtime-links/ws", sig) {
		t.Fatal("proof accepted toward another broker")
	}
	if VerifyPoP(pub, nonce, "rt-1", "wss://ohb.example/api/runtime-links/ws", "AAAA") {
		t.Fatal("malformed signature accepted")
	}
	if _, err := ParsePoPNonce(base64.StdEncoding.EncodeToString(nonce[:16])); err == nil {
		t.Fatal("short nonce accepted")
	}
}

func TestParseRawDeviceSeedPreservesEveryByte(t *testing.T) {
	cases := map[string][]byte{
		"leading space":    append([]byte{' '}, bytes.Repeat([]byte{7}, DeviceSeedSize-1)...),
		"trailing newline": append(bytes.Repeat([]byte{7}, DeviceSeedSize-1), '\n'),
		"whitespace only":  bytes.Repeat([]byte{'\t'}, DeviceSeedSize),
		"base64 alphabet":  bytes.Repeat([]byte{'A'}, DeviceSeedSize),
	}
	for name, seed := range cases {
		t.Run(name, func(t *testing.T) {
			key, err := ParseDeviceSeed(seed)
			if err != nil || !bytes.Equal(key.Seed(), seed) {
				t.Fatal("raw credential seed was rejected or changed")
			}
		})
	}
}
