package commands

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
	"golang.org/x/term"
)

var providerRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var labelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// runCredentials wraps `hermes auth list|add|remove` under the service
// user. The key travels on stdin only; a `--api-key` flag does not exist and
// is refused by cli.Run before elevation. An add is proven by reading
// /api/model/options on the loopback afterwards.
func runCredentials(env cli.Env, args []string) int {
	if len(args) == 0 {
		args = []string{"list"}
	}
	verb, rest := args[0], args[1:]
	fs := newFlagSet("credentials "+verb, env)
	label := fs.String("label", "", "credential label (add: default operator-<date>; remove: required)")
	keyFile := fs.String("api-key-file", "", "0600 file holding the API key (default: stdin, or a prompt without echo)")
	yes := fs.Bool("yes", false, "confirm the mutation")
	if err := fs.Parse(rest); err != nil {
		return cli.ExitUsage
	}
	if code := prepareRuntimeCLI(env); code != 0 {
		return code
	}
	h, err := currentRuntimeCLI()
	if err != nil {
		return fail(env, cli.ExitFailure, "runtime context could not be prepared: %v", err)
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	switch verb {
	case "list":
		res, err := exec.Must(ctx, runner, h.Command("auth", "list"))
		if err != nil {
			return fail(env, cli.ExitFailure, "%v", err)
		}
		printf(env.Stdout, "%s", strings.TrimRight(res.Stdout, "\n"))
		return cli.ExitOK
	case "add", "remove", "login":
	default:
		return fail(env, cli.ExitUsage, "usage: edge-setup credentials list | add <provider> [--label L] [--api-key-file F] --yes | login <provider> --yes | remove <provider> --label L --yes")
	}
	if fs.NArg() != 1 || !providerRe.MatchString(fs.Arg(0)) {
		return fail(env, cli.ExitUsage, "credentials %s requires exactly one provider slug (e.g. anthropic)", verb)
	}
	provider := fs.Arg(0)
	if !*yes {
		return fail(env, cli.ExitRefused, "credentials %s mutates the runtime; add --yes (nothing was changed)", verb)
	}
	if verb == "login" {
		return runCredentialsLogin(env, ctx, provider, h)
	}
	if verb == "remove" {
		if *label == "" || !labelRe.MatchString(*label) {
			return fail(env, cli.ExitRefused, "remove requires --label naming exactly which credential; run `credentials list` first")
		}
		before, err := h.Env.SnapshotRootEnv()
		if err != nil {
			return fail(env, cli.ExitFailure, "credential environment could not be read safely: %v", err)
		}
		_, commandErr := exec.Must(ctx, runner, h.Command("auth", "remove", provider, *label))
		mirrorErr := mirrorRuntimeCLI(h, before)
		if mirrorErr != nil {
			return fail(env, cli.ExitFailure, "credential removed but could not be mirrored to profiles: %v", mirrorErr)
		}
		if commandErr != nil {
			return fail(env, cli.ExitFailure, "the runtime refused to remove %q for %s: %v", *label, provider, commandErr)
		}
		if err := proveCredentialRemoved(ctx, runner, h, provider, *label); err != nil {
			return fail(env, cli.ExitFailure, "%v", err)
		}
		printf(env.Stdout, "removed %q for %s", *label, provider)
		return cli.ExitOK
	}
	if *label == "" {
		*label = "operator-" + time.Now().UTC().Format("20060102")
	}
	if !labelRe.MatchString(*label) {
		return fail(env, cli.ExitUsage, "invalid --label")
	}
	key, err := readSecret(*keyFile, "API key", "--api-key-file", "API key for "+provider+" (not echoed): ")
	if err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	before, err := h.Env.SnapshotRootEnv()
	if err != nil {
		return fail(env, cli.ExitFailure, "credential environment could not be read safely: %v", err)
	}
	cmd := h.Command("auth", "add", provider, "--type", "api-key", "--label", *label)
	cmd.Stdin = []byte(key + "\n")
	cmd.Timeout = 2 * time.Minute
	_, commandErr := exec.Must(ctx, runner, cmd)
	mirrorErr := mirrorRuntimeCLI(h, before)
	if mirrorErr != nil {
		return fail(env, cli.ExitFailure, "credential written but could not be mirrored to profiles: %v", mirrorErr)
	}
	if commandErr != nil {
		return fail(env, cli.ExitFailure, "the runtime refused the %s credential: %v", provider, redact(commandErr.Error(), key))
	}
	verdict, err := proveProvider(ctx, provider, h)
	if err != nil {
		return fail(env, cli.ExitFailure, "the runtime catalogue could not be read; the credential state is unproven: %v", err)
	}
	switch verdict {
	case gateway.Authenticated:
		printf(env.Stdout, "credential %q installed: %s authenticates against the runtime catalogue", *label, provider)
		return cli.ExitOK
	case gateway.Denied:
		return fail(env, cli.ExitFailure, "the credential was accepted by the CLI but %s still does not authenticate", provider)
	default:
		return fail(env, cli.ExitFailure, "%s does not appear in the runtime catalogue", provider)
	}
}

// runCredentialsLogin is the host-side twin of the OAuth flow openedbot
// drives through the link: same `hermes auth add <provider> --no-browser`
// under the service user, URL and code printed here, success proven on the
// catalogue and never on the CLI's word.
func runCredentialsLogin(env cli.Env, ctx context.Context, provider string, h runtimeCLI) int {
	ctx, cancel := context.WithTimeout(ctx, operator.LoginTimeout)
	defer cancel()
	before, err := h.Env.SnapshotRootEnv()
	if err != nil {
		return fail(env, cli.ExitFailure, "credential environment could not be read safely: %v", err)
	}
	login, err := h.Login(ctx, provider)
	if err != nil {
		return fail(env, cli.ExitFailure, "could not start the login: %v", err)
	}
	printf(env.Stdout, "device-code login for %s (15 min); open the URL below and enter the code", provider)
	for line := range login.Lines() {
		printf(env.Stdout, "  %s", strings.TrimSpace(line))
	}
	loginErr := login.Wait()
	mirrorErr := mirrorRuntimeCLI(h, before)
	if mirrorErr != nil {
		return fail(env, cli.ExitFailure, "credential written but could not be mirrored to profiles: %v", mirrorErr)
	}
	if loginErr != nil {
		return fail(env, cli.ExitFailure, "the login did not complete: %v", loginErr)
	}
	verdict, err := proveProvider(context.Background(), provider, h)
	if err != nil {
		return fail(env, cli.ExitFailure, "the runtime catalogue could not be read; the credential state is unproven: %v", err)
	}
	if verdict != gateway.Authenticated {
		return fail(env, cli.ExitFailure, "the CLI finished but %s still does not authenticate against the runtime catalogue", provider)
	}
	printf(env.Stdout, "login ✓  %s authenticates against the runtime catalogue", provider)
	return cli.ExitOK
}

func proveProvider(ctx context.Context, provider string, h runtimeCLI) (gateway.ProviderVerdict, error) {
	token, err := h.Token()
	if err != nil {
		return "", err
	}
	body, err := gateway.Loopback(token).ModelOptions(ctx)
	if err != nil {
		return "", err
	}
	return gateway.ProviderState(body, provider)
}

// readSecret reads one line from a 0600 file, from a pipe, or from the
// terminal without echo. It never logs the value. `what` names the secret
// in every error ("API key", "ticket"); `flag` names the file flag.
func readSecret(file, what, flag, prompt string) (string, error) {
	var value string
	if file != "" {
		if _, err := fsx.RequireRegular(file, 0o600, fsx.Current()); err != nil {
			return "", fmt.Errorf("%s must be a 0600 regular file owned by the caller: %w", flag, err)
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return "", err
		}
		value = string(data)
	} else if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprint(os.Stderr, prompt)
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		value = string(b)
	} else {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			return "", fmt.Errorf("no %s was supplied on %s, stdin or the terminal", what, flag)
		}
		value = line
	}
	value = strings.TrimRight(value, "\r\n")
	if value == "" {
		return "", fmt.Errorf("the %s is empty", what)
	}
	if strings.ContainsAny(value, "\r\n") {
		return "", fmt.Errorf("the %s must be a single line", what)
	}
	return value, nil
}

func redact(msg, secret string) string {
	if secret == "" {
		return msg
	}
	return strings.ReplaceAll(msg, secret, "[redacted]")
}

func init() {
	cli.Register(cli.Command{Name: "credentials", Summary: "List, add, login (OAuth) or remove a model-provider credential", Run: runCredentials})
}
