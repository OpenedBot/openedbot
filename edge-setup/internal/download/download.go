// Package download fetches pinned artefacts over HTTPS and refuses anything
// whose checksum does not match before it is written to its final path.
package download

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

// Algorithm selects the digest.
type Algorithm string

// Digest algorithms.
const (
	SHA256 Algorithm = "sha256"
	SHA512 Algorithm = "sha512"
)

// Client downloads with retries.
type Client struct {
	HTTP    *http.Client
	Retries int
	Backoff time.Duration
	// MaxBytes bounds a download; zero means 512 MiB.
	MaxBytes int64
}

// Default is a client with sane timeouts.
func Default() Client {
	return Client{HTTP: &http.Client{Timeout: 10 * time.Minute}, Retries: 5, Backoff: 15 * time.Second, MaxBytes: 512 << 20}
}

// ErrChecksum is returned when the digest does not match.
var ErrChecksum = errors.New("checksum mismatch")

// Fetch downloads url to dest (mode, owner) only if its digest matches. If
// dest already exists with the right digest, mode and owner, nothing is
// downloaded; any other file there is replaced.
func (c Client) Fetch(ctx context.Context, url, dest string, algo Algorithm, want string, mode fs.FileMode, owner fsx.Owner) error {
	if !strings.HasPrefix(url, "https://") {
		return fmt.Errorf("download %s: only https is allowed", url)
	}
	if reusable(dest, algo, want, mode, owner) {
		return nil
	}
	// A zero-value Client is a caller's mistake, not a reason to crash a
	// privileged install half way through: answer it like any other transport
	// failure, which every caller already handles.
	if c.HTTP == nil {
		return fmt.Errorf("download %s: no HTTP client configured", url)
	}
	var last error
	retries := c.Retries
	if retries < 1 {
		retries = 1
	}
	for attempt := 1; attempt <= retries; attempt++ {
		last = c.fetchOnce(ctx, url, dest, algo, want, mode, owner)
		if last == nil {
			return nil
		}
		if errors.Is(last, ErrChecksum) || ctx.Err() != nil {
			return last
		}
		if attempt < retries {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(c.Backoff):
			}
		}
	}
	return last
}

func (c Client) fetchOnce(ctx context.Context, url, dest string, algo Algorithm, want string, mode fs.FileMode, owner fsx.Owner) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "edge-setup")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}
	dir := filepath.Dir(dest)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(dest)+".download.*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	h := newHash(algo)
	max := c.MaxBytes
	if max == 0 {
		max = 512 << 20
	}
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, max+1))
	if err != nil {
		_ = tmp.Close()
		return fmt.Errorf("download %s: %w", url, err)
	}
	if n > max {
		_ = tmp.Close()
		return fmt.Errorf("download %s: exceeds %d bytes", url, max)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, want) {
		return fmt.Errorf("download %s: %w: got %s want %s", url, ErrChecksum, got, want)
	}
	data, err := os.ReadFile(tmpName)
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(dest, data, mode, owner)
}

// reusable reports whether dest already is the verified artefact. The right
// bytes are not enough: a file another account owns, or may write, can be
// changed after this check and before the caller runs or unpacks it, so only
// a regular file with exactly the requested mode and owner is kept. The digest
// is computed on the very descriptor whose owner and mode were checked.
func reusable(dest string, algo Algorithm, want string, mode fs.FileMode, owner fsx.Owner) bool {
	data, err := fsx.ReadRegular(dest, mode.Perm(), owner)
	if err != nil {
		return false
	}
	h := newHash(algo)
	_, _ = h.Write(data)
	return strings.EqualFold(hex.EncodeToString(h.Sum(nil)), want)
}

func newHash(algo Algorithm) hash.Hash {
	if algo == SHA512 {
		return sha512.New()
	}
	return sha256.New()
}

// VerifyFile reports whether path exists and has the expected digest.
func VerifyFile(path string, algo Algorithm, want string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	h := newHash(algo)
	if _, err := io.Copy(h, f); err != nil {
		return false, err
	}
	return strings.EqualFold(hex.EncodeToString(h.Sum(nil)), want), nil
}
