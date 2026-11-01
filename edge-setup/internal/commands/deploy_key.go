package commands

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// deployKeyPath is where the deployment secret lives; a variable so tests
// point it at a temporary file.
var deployKeyPath = layout.DeployKey

// deployKeyBytes is the size of the secret: 32 bytes, given as 64 hex chars.
const deployKeyBytes = 32

var deployKeyRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// upgradeTagPrefix domain-separates the tag from any other HMAC the key
// could sign. The tagged message is prefix || sha256hex(binary) || "\n".
const upgradeTagPrefix = "hermes-setup upgrade v1\n"

// errNoDeployKey is the refusal when the host has no deployment secret.
var errNoDeployKey = errors.New("no deployment key on this host; run `edge-setup deploy-key set` (nothing was changed)")

// parseDeployKey accepts exactly 64 lowercase-or-uppercase hex characters,
// surrounded by whitespace at most.
func parseDeployKey(raw string) ([]byte, error) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if !deployKeyRe.MatchString(s) {
		return nil, fmt.Errorf("deployment key must be %d hex characters (openssl rand -hex %d), got %d", 2*deployKeyBytes, deployKeyBytes, len(s))
	}
	return hex.DecodeString(s)
}

// readDeployKey loads the secret; a missing file is errNoDeployKey, a
// malformed one is refused with its own message.
func readDeployKey(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errNoDeployKey
	}
	if err != nil {
		return nil, err
	}
	key, err := parseDeployKey(string(data))
	if err != nil {
		return nil, fmt.Errorf("%s: %v", path, err)
	}
	return key, nil
}

// upgradeTag is the HMAC-SHA256 tag, lowercase hex, of a binary whose
// SHA-256 (lowercase hex) is sum. The same string is what `make deploy`
// computes with openssl on the developer machine.
func upgradeTag(key []byte, sum string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(upgradeTagPrefix + sum + "\n"))
	return hex.EncodeToString(mac.Sum(nil))
}

// upgradeTagMatches compares in constant time.
func upgradeTagMatches(key []byte, sum, tag string) bool {
	want, err := hex.DecodeString(upgradeTag(key, sum))
	if err != nil {
		return false
	}
	got, err := hex.DecodeString(tag)
	if err != nil {
		return false
	}
	return hmac.Equal(want, got)
}

// requireDeployKey reads the secret for `upgrade --from` or fails with the
// refusal code; nothing has been written when it fails.
func requireDeployKey(env cli.Env, path string) ([]byte, int) {
	key, err := readDeployKey(path)
	if err != nil {
		return nil, fail(env, cli.ExitRefused, "upgrade --from: %v", err)
	}
	return key, 0
}

// deployKeySet reads one line from r and installs it at path, private to
// its owner. The key never travels in argv: stdin only.
func deployKeySet(env cli.Env, r io.Reader, path string, owner fsx.Owner) int {
	line, err := bufio.NewReader(io.LimitReader(r, 1024)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return fail(env, cli.ExitFailure, "deploy-key set: read stdin: %v", err)
	}
	key, err := parseDeployKey(line)
	if err != nil {
		return fail(env, cli.ExitUsage, "deploy-key set: %v (nothing was changed)", err)
	}
	if err := fsx.WriteAtomic(path, []byte(hex.EncodeToString(key)+"\n"), 0o600, owner); err != nil {
		return fail(env, cli.ExitFailure, "deploy-key set: %v", err)
	}
	printf(env.Stdout, "deployment key installed at %s (mode 0600); `make deploy` can now tag uploads for this host", path)
	return cli.ExitOK
}

// deployKeyStatus says whether a usable key is installed, never its value.
func deployKeyStatus(env cli.Env, path string) int {
	_, err := readDeployKey(path)
	switch {
	case err == nil:
		printf(env.Stdout, "deployment key: present (%s)", path)
	case errors.Is(err, errNoDeployKey):
		printf(env.Stdout, "deployment key: absent (%s); `upgrade --from` is refused until `deploy-key set`", path)
	case errors.Is(err, os.ErrPermission):
		return fail(env, cli.ExitPrivilege, "deploy-key status: %s is not readable by this user (sudo edge-setup deploy-key status)", path)
	default:
		return fail(env, cli.ExitFailure, "deployment key: unusable: %v", err)
	}
	return cli.ExitOK
}

func runDeployKey(env cli.Env, args []string) int {
	fs := newFlagSet("deploy-key", env)
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if fs.NArg() != 1 {
		return fail(env, cli.ExitUsage, "usage: edge-setup deploy-key set  (reads 64 hex characters on stdin) | status")
	}
	if runtime.GOOS == "darwin" {
		return runMacDeployKey(env, fs.Arg(0))
	}
	switch fs.Arg(0) {
	case "set":
		if code := requireRoot(env); code != 0 {
			return code
		}
		return deployKeySet(env, os.Stdin, deployKeyPath, fsx.Root)
	case "status":
		return deployKeyStatus(env, deployKeyPath)
	default:
		return fail(env, cli.ExitUsage, "deploy-key: unknown verb %q (set | status)", fs.Arg(0))
	}
}

func runMacDeployKey(env cli.Env, verb string) int {
	if verb != "set" && verb != "status" {
		return fail(env, cli.ExitUsage, "deploy-key: expected set or status")
	}
	if code := prepareConnectorHost(env); code != 0 {
		return code
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS user home is unavailable")
	}
	p, err := layout.MacRuntime(home)
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS paths are invalid")
	}
	if err := inspectMacUpgradePaths(home, p); err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	path := filepath.Join(p.AppRoot, "deploy.key")
	if verb == "set" {
		unlock, err := lockMacRuntime(p)
		if err != nil {
			return fail(env, cli.ExitRefused, "macOS setup is busy or its lock is unsafe")
		}
		defer unlock()
		if _, err := fsx.RequireRegular(path, 0o600, fsx.Current()); err != nil {
			return fail(env, cli.ExitRefused, "macOS deployment key file is unsafe")
		}
		return deployKeySet(env, os.Stdin, path, fsx.Current())
	}
	data, err := fsx.ReadRegular(path, 0o600, fsx.Current())
	if errors.Is(err, os.ErrNotExist) {
		printf(env.Stdout, "deployment key: absent; uploaded upgrades require deploy-key set")
		return cli.ExitOK
	}
	if err != nil {
		return fail(env, cli.ExitRefused, "macOS deployment key is inaccessible or unsafe")
	}
	key, err := parseDeployKey(string(data))
	clear(data)
	clear(key)
	if err != nil {
		return fail(env, cli.ExitRefused, "macOS deployment key is invalid")
	}
	printf(env.Stdout, "deployment key: present (user-owned, mode 0600)")
	return cli.ExitOK
}

func init() {
	cli.Register(cli.Command{Name: "deploy-key", Summary: "Install (set, from stdin) or report (status) the secret that tags binaries for `upgrade --from --tag`", Run: runDeployKey})
}
