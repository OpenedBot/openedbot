package commands

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/acpbridge"
	"github.com/OpenedBot/openedbot/edge-setup/internal/agents"
	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
)

func init() {
	cli.Register(cli.Command{Name: "connect", Summary: "Detect the agent CLIs of this account (Codex, Claude Code, Grok, Gemini, OpenCode) and connect them to openedbot", Run: runConnect})
}

var connectWorkspaceID = regexp.MustCompile(`^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

// localAgent is one known agent as found under this account.
type localAgent struct {
	agents.Agent
	path      string
	env       []string
	catalogue *acpbridge.Catalogue
	// problem says why the agent cannot be connected; empty when it is ready.
	problem string
}

type connectSetup struct {
	origin, workspaceID, workspace, root string
	home, path                           string
}

func runConnect(env cli.Env, args []string) int {
	flags := newFlagSet("connect", env)
	origin := flags.String("openedbot", "http://127.0.0.1:8790", "openedbot link origin (HTTPS or HTTP on loopback)")
	workspace := flags.String("workspace", ".", "working directory of the agents")
	workspaceID := flags.String("workspace-id", "", "openedbot workspace ID from the pairing command")
	ticketFile := flags.String("ticket-file", "", "read the enrollment ticket from this file instead of the prompt")
	foreground := flags.Bool("foreground", false, "run the agents in this process instead of a user service (the desktop app)")
	serve := flags.Bool("serve", false, "run the paired agents without asking for a ticket (the user service)")
	probe := flags.Bool("probe", false, "list the agents and their state, then stop")
	stateRoot := flags.String("state-root", "", "state directory of this pairing (set by the user service)")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return cli.ExitUsage
	}
	if os.Geteuid() == 0 {
		return fail(env, cli.ExitRefused, "run connect as your normal user, without sudo")
	}
	u, err := enroll.ParseOpenedbotURL(*origin, true)
	if err != nil {
		return fail(env, cli.ExitUsage, "%v", err)
	}
	if !*probe && !connectWorkspaceID.MatchString(*workspaceID) {
		return fail(env, cli.ExitUsage, "--workspace-id must be the UUID from the pairing command")
	}
	dir, err := filepath.Abs(*workspace)
	if err == nil {
		dir, err = filepath.EvalSymlinks(dir)
	}
	if info, statErr := os.Stat(dir); err != nil || statErr != nil || !info.IsDir() {
		return fail(env, cli.ExitUsage, "--workspace must be a directory")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "home directory is unavailable")
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "user configuration directory is unavailable")
	}
	id := sha256.Sum256([]byte(u.String() + "\x00" + *workspaceID + "\x00" + dir))
	setup := connectSetup{
		origin: u.String(), workspaceID: *workspaceID, workspace: dir, home: home, path: agents.SearchPath(home),
		root: filepath.Join(base, "openedbot-connect", hex.EncodeToString(id[:12])),
	}
	// The service gets the root its pairing used: its own XDG_CONFIG_HOME may differ.
	if *stateRoot != "" {
		if !filepath.IsAbs(*stateRoot) {
			return fail(env, cli.ExitUsage, "--state-root must be absolute")
		}
		setup.root = filepath.Clean(*stateRoot)
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	// The CLIs' own settings (CODEX_HOME, CLAUDE_CONFIG_DIR, Gemini keys…) live
	// in the pairing shell: the service reads them back from a 0600 file,
	// never from its unit or plist.
	if *serve {
		if err := loadAgentSettings(setup); err != nil {
			return fail(env, cli.ExitFailure, "%v", err)
		}
	}

	found := detectAgents(ctx, env, setup, !*serve && !*probe)
	ready := []localAgent{}
	for _, a := range found {
		if a.problem == "" {
			ready = append(ready, a)
		}
	}
	if *probe {
		return cli.ExitOK
	}
	if len(ready) == 0 {
		return fail(env, cli.ExitRefused, "no agent CLI is ready to connect on this account")
	}
	tickets := &ticketSource{file: *ticketFile, allowed: !*serve}
	if !*serve {
		// A service of this pairing holds each agent's lock and bridge: it is
		// stopped while pairing, then installed and restarted below.
		if !*foreground {
			stopUserService(setup)
		}
		for i := range ready {
			if err := pairAgent(ctx, env, setup, ready[i], tickets); err != nil {
				return fail(env, cli.ExitFailure, "%s: %v", ready[i].Name, err)
			}
			printf(env.Stdout, "Paired %s.", ready[i].Name)
		}
		if !*foreground {
			if err := saveAgentSettings(setup); err != nil {
				return fail(env, cli.ExitFailure, "%v", err)
			}
			if err := installUserService(env, setup); err != nil {
				return fail(env, cli.ExitFailure, "%v", err)
			}
			return cli.ExitOK
		}
	}
	return runAgents(ctx, env, setup, ready, tickets)
}

// detectAgents finds every known agent, installs a missing adapter when its
// CLI is present, and probes the login and catalogue of the others.
func detectAgents(ctx context.Context, env cli.Env, setup connectSetup, install bool) []localAgent {
	if _, err := os.Stat(layout.ToolConfig); err == nil {
		printf(env.Stdout, "%-12s connected by the host installation (edge-setup up)", "Hermes")
	} else {
		printf(env.Stdout, "%-12s not installed here (sudo edge-setup up installs it on a server)", "Hermes")
	}
	found := make([]localAgent, len(agents.Known))
	var wg sync.WaitGroup
	for i, known := range agents.Known {
		found[i] = localAgent{Agent: known, env: known.Environment(setup.home, setup.path)}
		path, err := agents.Find(known.Binary, setup.path)
		if err != nil && known.Requires != "" && install {
			if _, missing := agents.Find(known.Requires, setup.path); missing == nil {
				path, err = installAdapter(ctx, env, setup, known)
			}
		}
		if err != nil {
			found[i].problem = "not installed"
			continue
		}
		found[i].path = path
		wg.Add(1)
		go func(a *localAgent) {
			defer wg.Done()
			var err error
			if a.Codex {
				a.catalogue, err = acpbridge.ProbeCodex(ctx, a.path, a.env, setup.workspace)
				if err == nil {
					a.catalogue.Version = commandVersion(ctx, a.path, a.env, "codex-cli")
				}
			} else {
				a.catalogue, err = acpbridge.ProbeACP(ctx, a.path, a.Args, a.env, setup.workspace, a.Provider, a.Name)
			}
			switch {
			case errors.Is(err, acpbridge.ErrLoginRequired):
				a.problem = "needs a login: run " + a.Login
			case err != nil:
				a.problem = err.Error()
			}
		}(&found[i])
	}
	wg.Wait()
	for _, a := range found {
		if a.problem != "" {
			printf(env.Stdout, "%-12s %s", a.Name, a.problem)
			continue
		}
		printf(env.Stdout, "%-12s ready, %d models (%s)", a.Name, len(a.catalogue.Models), a.path)
	}
	return found
}

func installAdapter(ctx context.Context, env cli.Env, setup connectSetup, a agents.Agent) (string, error) {
	tool, err := agents.Find(a.Install[0], setup.path)
	if err != nil {
		printf(env.Stdout, "%-12s needs its adapter, but %s is missing: install %s, then run %s", a.Name, a.Install[0], a.Install[0], strings.Join(a.Install, " "))
		return "", err
	}
	printf(env.Stdout, "%-12s installing its adapter: %s", a.Name, strings.Join(a.Install, " "))
	command := exec.CommandContext(ctx, tool, a.Install[1:]...)
	command.Env = a.Environment(setup.home, setup.path)
	command.Stdout, command.Stderr = nil, nil
	if err := command.Run(); err != nil {
		return "", fmt.Errorf("adapter install failed: %w", err)
	}
	return agents.Find(a.Binary, setup.path)
}

func commandVersion(ctx context.Context, path string, env []string, prefix string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, path, "--version")
	command.Env = env
	output, err := command.Output()
	version := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(output)), prefix))
	if err != nil || len(version) > 64 || strings.ContainsAny(version, "\r\n") {
		return ""
	}
	return version
}

// ticketSource reads the enrollment ticket once, on first need, for every
// agent paired in the same run: a machine ticket has one place per engine.
type ticketSource struct {
	mu      sync.Mutex
	file    string
	allowed bool
	value   string
}

var errServicePairing = errors.New("this agent is not paired: run edge-setup connect again from the openedbot console")

func (t *ticketSource) get() (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.allowed {
		return "", errServicePairing
	}
	if t.value == "" {
		raw, err := readSecret(t.file, "enrollment ticket", "--ticket-file", "Enrollment ticket (not echoed): ")
		if err != nil {
			return "", err
		}
		ticket, err := enroll.ParseTicket(raw)
		if err != nil {
			return "", err
		}
		t.value = ticket.ID + "." + ticket.Secret
	}
	return t.value, nil
}

func agentState(setup connectSetup, a localAgent) string { return filepath.Join(setup.root, a.Slug()) }

func newAgentClient(env cli.Env, setup connectSetup, a localAgent, bridge, bearer string, journal *connector.Journal) *connector.Client {
	c := connector.New(wsURLOf(setup.origin), connector.Auth{}, bridge, bearer, journal)
	c.Engine = a.Engine
	c.EngineVersion = a.catalogue.Version
	c.Agent = "edge-setup/" + env.Version
	c.HTTP = &http.Client{Transport: &http.Transport{}}
	c.StopOnInvalidCredential = true
	return c
}

// pairAgent spends one place of the ticket for an agent with no stored link,
// or whose stored link the API no longer admits (runtime removed, link
// revoked): the service that follows never prompts, so this is the last
// moment a ticket can replace it.
//
// The bridge runs meanwhile: openedbot probes the agent through the link
// before it issues the runtime (`LINK_PROBE_FAILED` without it).
func pairAgent(ctx context.Context, env cli.Env, setup connectSetup, a localAgent, tickets *ticketSource) error {
	return withAgentBridge(ctx, env, setup, a, func(ctx context.Context, state string, c *connector.Client) error {
		_, stored := os.Stat(filepath.Join(state, "link.json"))
		lf, key, err := agentLink(ctx, state, setup.origin, c, false, tickets)
		if err != nil || stored != nil {
			return err
		}
		err = storedLinkAdmitted(ctx, state, setup, c, lf, key)
		if errors.Is(err, connector.ErrLinkCredentialInvalid) {
			_, _, err = agentLink(ctx, state, setup.origin, c, true, tickets)
		}
		return err
	})
}

// storedLinkAdmitted opens the stored link until the API admits it, then closes it.
func storedLinkAdmitted(ctx context.Context, state string, setup connectSetup, c *connector.Client, lf LinkFile, key ed25519.PrivateKey) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c.Auth = connector.Auth{RuntimeID: lf.RuntimeID, LinkToken: lf.LinkToken}
	c.DeviceKey = key
	c.OnLinkIssued = nil
	c.OnLinkRotated = func(runtimeID, token string) error {
		if lf.RuntimeID != runtimeID {
			return errors.New("unexpected runtime identity")
		}
		return persistRotatedLinkToken(filepath.Join(state, "link-token.json"), runtimeID, token, time.Now())
	}
	admitted := false
	c.OnLinkContext = func(link connector.LinkContext) error {
		admitted = link.Organization.ID == setup.workspaceID
		cancel()
		return nil
	}
	err := c.Run(ctx)
	if admitted {
		return nil
	}
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return errors.New("openedbot did not admit the stored link")
	}
	return err
}

// agentSettingsFile keeps the variables the agents read, for the service.
func agentSettingsFile(setup connectSetup) string { return filepath.Join(setup.root, "agents.env") }

func saveAgentSettings(setup connectSetup) error {
	names := []string{"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "LANG"}
	for _, a := range agents.Known {
		names = append(names, a.Env...)
	}
	lines := []string{}
	for _, name := range names {
		if value, ok := os.LookupEnv(name); ok && !strings.ContainsAny(value, "\r\n\x00") {
			lines = append(lines, name+"="+value)
		}
	}
	if err := fsx.EnsureDir(setup.root, 0700, fsx.Current()); err != nil {
		return err
	}
	return fsx.WriteAtomic(agentSettingsFile(setup), []byte(strings.Join(lines, "\n")+"\n"), 0600, fsx.Current())
}

func loadAgentSettings(setup connectSetup) error {
	data, err := fsx.ReadRegular(agentSettingsFile(setup), 0600, fsx.Current())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if name, value, ok := strings.Cut(line, "="); ok && name != "" {
			if err := os.Setenv(name, value); err != nil {
				return err
			}
		}
	}
	return nil
}

// agentLink returns the stored link of an agent, or pairs it with the ticket.
func agentLink(ctx context.Context, state, origin string, c *connector.Client, replaceInvalid bool, tickets *ticketSource) (LinkFile, ed25519.PrivateKey, error) {
	var lf LinkFile
	owner := fsx.Current()
	path := filepath.Join(state, "link.json")
	keyPath := filepath.Join(state, "device-key")
	if !replaceInvalid {
		data, err := fsx.ReadRegular(path, 0600, owner)
		if err == nil {
			if json.Unmarshal(data, &lf) != nil || lf.Schema != 1 || lf.Openedbot != origin ||
				lf.WSURL != wsURLOf(origin) || lf.RuntimeID == "" || lf.LinkToken == "" {
				return lf, nil, errors.New("invalid stored link")
			}
			seed, err := fsx.ReadRegular(keyPath, 0600, owner)
			if err != nil {
				return lf, nil, err
			}
			key, err := enroll.ParseDeviceSeed(seed)
			if err != nil {
				return lf, nil, err
			}
			rotated, err := loadRotatedLinkToken(filepath.Join(state, "link-token.json"), lf.RuntimeID)
			if rotated != "" {
				lf.LinkToken = rotated
			}
			return lf, key, err
		}
		if !errors.Is(err, os.ErrNotExist) {
			return lf, nil, err
		}
	}
	ticket, err := tickets.get()
	if err != nil {
		return lf, nil, err
	}
	key, err := enroll.GenerateDeviceKey()
	if err != nil {
		return lf, nil, err
	}
	c.DeviceKey = key
	c.Auth = connector.Auth{EnrollmentTicket: ticket}
	c.OnLinkIssued = func(runtimeID, token string) error {
		lf = LinkFile{Schema: 1, Openedbot: origin, WSURL: wsURLOf(origin), RuntimeID: runtimeID, LinkToken: token, LinkedAt: time.Now().UTC().Format(time.RFC3339)}
		data, err := json.Marshal(lf)
		if err != nil {
			return err
		}
		if err := fsx.WriteAtomic(keyPath, enroll.EncodeDeviceSeed(key), 0600, owner); err != nil {
			return err
		}
		return fsx.WriteAtomic(path, data, 0600, owner)
	}
	timeout, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	if err := c.Session(timeout); err != nil {
		return lf, nil, err
	}
	if lf.RuntimeID == "" {
		return lf, nil, errors.New("the API did not issue a link")
	}
	return lf, key, nil
}

// runAgents serves every ready agent in this process until a signal. An
// agent that stops is reported; the others keep running.
func runAgents(ctx context.Context, env cli.Env, setup connectSetup, ready []localAgent, tickets *ticketSource) int {
	results := make(chan error, len(ready))
	for _, a := range ready {
		go func(a localAgent) {
			err := serveAgent(ctx, env, setup, a, tickets)
			if err != nil && ctx.Err() == nil {
				fmt.Fprintf(env.Stderr, "edge-setup: %s stopped: %v\n", a.Name, err)
			}
			results <- err
		}(a)
	}
	failed := 0
	for range ready {
		if err := <-results; err != nil && ctx.Err() == nil {
			failed++
		}
	}
	if failed == len(ready) {
		return cli.ExitFailure
	}
	return cli.ExitOK
}

func serveAgent(ctx context.Context, env cli.Env, setup connectSetup, a localAgent, tickets *ticketSource) error {
	return withAgentBridge(ctx, env, setup, a, func(ctx context.Context, state string, c *connector.Client) error {
		return runAgentLink(ctx, env, state, setup, a, c, tickets)
	})
}

// withAgentBridge holds the agent's lock, serves its bridge and operator
// socket, and runs `run` with a link client routed to that bridge.
func withAgentBridge(ctx context.Context, env cli.Env, setup connectSetup, a localAgent, run func(ctx context.Context, state string, c *connector.Client) error) error {
	state := agentState(setup, a)
	owner := fsx.Current()
	if err := fsx.EnsureDir(state, 0700, owner); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(state, "lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("already running in another edge-setup connect")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	profiles := filepath.Join(state, "profiles")
	if err := fsx.EnsureDir(profiles, 0700, owner); err != nil {
		return err
	}
	bearerBytes := make([]byte, 32)
	if _, err := rand.Read(bearerBytes); err != nil {
		return err
	}
	bearer := hex.EncodeToString(bearerBytes)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	protocol := ""
	if a.Codex {
		protocol = acpbridge.ProtocolCodex
	}
	bridge, err := acpbridge.New(acpbridge.Options{
		ListenAddress: listener.Addr().String(), Bearer: bearer, StateDirectory: filepath.Join(state, "bridge"),
		ProfilesRoot: profiles, Protocol: protocol, Workspace: setup.workspace, Catalogue: a.catalogue,
		AgentCommand: a.path, AgentArguments: a.Args, AgentEnvironmentValues: a.env,
	})
	if err != nil {
		return err
	}
	defer bridge.Close()
	socketDir, err := os.MkdirTemp("", "openedbot-connect-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(socketDir)
	socket := filepath.Join(socketDir, "operator.sock")
	services := make(chan error, 3)
	go func() { services <- bridge.ServeListener(ctx, listener) }()
	go func() { services <- operator.ListenAsUser(ctx, socket, operator.UserAgentHost(profiles)) }()
	for {
		connection, err := net.DialTimeout("unix", socket, 200*time.Millisecond)
		if err == nil {
			_ = connection.Close()
			break
		}
		select {
		case err := <-services:
			return err
		case <-ctx.Done():
			return nil
		case <-time.After(25 * time.Millisecond):
		}
	}
	journal, err := connector.NewJournal(filepath.Join(state, "runs"))
	if err != nil {
		return err
	}
	c := newAgentClient(env, setup, a, "http://"+listener.Addr().String(), bearer, journal)
	c.OperatorSocket = socket
	go func() { services <- run(ctx, state, c) }()
	select {
	case err := <-services:
		return err
	case <-ctx.Done():
		return nil
	}
}

func runAgentLink(ctx context.Context, env cli.Env, state string, setup connectSetup, a localAgent, c *connector.Client, tickets *ticketSource) error {
	lf, key, err := agentLink(ctx, state, setup.origin, c, false, tickets)
	if err != nil {
		return err
	}
	applyCredentials := func() {
		c.Auth = connector.Auth{RuntimeID: lf.RuntimeID, LinkToken: lf.LinkToken}
		c.DeviceKey = key
		c.OnLinkIssued = nil
	}
	applyCredentials()
	c.OnLinkRotated = func(runtimeID, token string) error {
		if lf.RuntimeID != runtimeID {
			return errors.New("unexpected runtime identity")
		}
		return persistRotatedLinkToken(filepath.Join(state, "link-token.json"), runtimeID, token, time.Now())
	}
	ready := false
	c.OnLinkContext = func(link connector.LinkContext) error {
		// The context arrives after admission. The proof challenge can be
		// the first frame, while the broker still refuses routed requests.
		if !ready && c.Auth.EnrollmentTicket == "" && link.Organization.ID == setup.workspaceID {
			ready = true
			printf(env.Stdout, "ready %s", a.Engine)
		}
		return nil
	}
	err = c.Run(ctx)
	if ready || !errors.Is(err, connector.ErrLinkCredentialInvalid) {
		return err
	}
	// The stored link was revoked: pair again, with the ticket of this run.
	lf, key, err = agentLink(ctx, state, setup.origin, c, true, tickets)
	if err != nil {
		return err
	}
	applyCredentials()
	return c.Run(ctx)
}
