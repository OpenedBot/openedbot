package commands

import (
	"bufio"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"strings"

	"golang.org/x/term"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hardening"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// readableAlphabet leaves out the characters that read alike (0/O,
// 1/l/I) so a password copied from the screen is typed right the first time.
const readableAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"

// generateAdminPassword returns 5 groups of 5 characters, about 146 bits.
func generateAdminPassword(random io.Reader) (string, error) {
	max := big.NewInt(int64(len(readableAlphabet)))
	var b strings.Builder
	for i := 0; i < 25; i++ {
		if i > 0 && i%5 == 0 {
			b.WriteByte('-')
		}
		n, err := rand.Int(random, max)
		if err != nil {
			return "", err
		}
		b.WriteByte(readableAlphabet[n.Int64()])
	}
	return b.String(), nil
}

// adminTTY is the controlling terminal. The prompt, the generated password and
// the confirmation go through it and nowhere else: never through stdout or
// stderr, which the install journal records and a pipe may log.
type adminTTY struct {
	r        *bufio.Reader
	w        io.Writer
	readHide func() (string, error)
}

func openAdminTTY() (*adminTTY, func(), error) {
	f, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return nil, nil, err
	}
	fd := int(f.Fd())
	if !term.IsTerminal(fd) {
		_ = f.Close()
		return nil, nil, errors.New("/dev/tty is not a terminal")
	}
	t := &adminTTY{r: bufio.NewReader(f), w: f, readHide: func() (string, error) {
		b, err := term.ReadPassword(fd)
		return string(b), err
	}}
	return t, func() { _ = f.Close() }, nil
}

// readAdminPasswordFile reads the password from a 0600 file owned by the
// caller (unattended installs). The file is the caller's to delete.
func readAdminPasswordFile(path string) (string, error) {
	if _, err := fsx.RequireRegular(path, 0o600, fsx.Current()); err != nil {
		return "", fmt.Errorf("--admin-password-file must be a 0600 regular file owned by the caller: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	p := strings.TrimRight(string(data), "\r\n")
	if err := hardening.ValidAdminPassword(p); err != nil {
		return "", err
	}
	return p, nil
}

// askAdminPassword asks on the terminal, twice, without echo. An empty answer
// generates one instead; it is shown once on the terminal and the operator
// confirms it is stored before anything on the host changes.
func askAdminPassword(t *adminTTY, random io.Reader) (string, error) {
	fmt.Fprintf(t.w, "\nsudo password for %s (it asks it for every sudo; nothing is changed yet).\n", layout.AdminUser)
	fmt.Fprintf(t.w, "Type one (%d characters or more), or press Enter to generate one: ", layout.PasswordMinLength)
	first, err := t.readHide()
	fmt.Fprintln(t.w)
	if err != nil {
		return "", err
	}
	if first == "" {
		p, err := generateAdminPassword(random)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(t.w, "\n  %s\n\nThis is shown once and recorded nowhere: store it now (password manager).\n", p)
		fmt.Fprintf(t.w, "verify-access, from a new SSH session, will need it. Type \"stored\" to go on: ")
		answer, err := t.r.ReadString('\n')
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(answer) != "stored" {
			return "", errors.New("the generated sudo password was not confirmed as stored; nothing was changed")
		}
		// Push the password out of the visible screen once it is stored.
		fmt.Fprint(t.w, "\x1b[2J\x1b[H")
		return p, nil
	}
	if err := hardening.ValidAdminPassword(first); err != nil {
		return "", err
	}
	fmt.Fprint(t.w, "Again: ")
	second, err := t.readHide()
	fmt.Fprintln(t.w)
	if err != nil {
		return "", err
	}
	if first != second {
		return "", errors.New("the two sudo passwords differ; nothing was changed")
	}
	return first, nil
}

// adminSudoPassword returns the password `up` gives hermes-admin, from
// --admin-password-file or the terminal. Without either it refuses, naming
// both ways out: it never prints a password where a log could keep it.
func adminSudoPassword(file string, open func() (*adminTTY, func(), error)) (string, error) {
	if file != "" {
		return readAdminPasswordFile(file)
	}
	t, done, err := open()
	if err != nil {
		return "", fmt.Errorf("no terminal to ask the sudo password of %s (%v): pass --admin-password-file FILE (0600) or --admin-sudo=%s; nothing was changed", layout.AdminUser, err, layout.AdminSudoNoPasswd)
	}
	defer done()
	return askAdminPassword(t, rand.Reader)
}
