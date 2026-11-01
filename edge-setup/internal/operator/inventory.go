package operator

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

//go:embed inventory_probe.py
var inventoryProbeScript []byte

//go:embed mcp_oauth_probe.py
var mcpOAuthProbeScript []byte

// MaxProbeOutput bounds the single JSON document the program may return.
const MaxProbeOutput = 512 << 10

// ReadCacheTTL is how long a READ verb's document is reused.
//
// Every read starts a cold interpreter that imports the whole `hermes_cli`
// tree, which costs seconds on a one-vCPU host. Without this, opening the
// capability page twice pays it twice, and the settable-toolset list, needed
// to render the page at all, is on that critical path.
//
// The window is short and, more importantly, it is INVALIDATED by our own
// writes: a toolset toggle or an MCP change drops the cache, so the operator
// never serves a document that contradicts a change it just made. What the
// window can hide is a change made by someone else at the console, for at most
// a minute.
const ReadCacheTTL = time.Minute

// Probe executes one verb of the interpreter program with a JSON request on
// stdin. It is injectable so the HTTP contract is proven without a runtime.
type Probe func(ctx context.Context, verb string, request []byte) ([]byte, error)

// InstallProbe materialises the embedded program under the tool's root. It is
// rewritten by every `up` and `upgrade`: the binary's copy is the only
// authority, so an edited file on disk never survives a converge.
//
// It must run from a root command, NOT from the operator service: that unit is
// ProtectSystem=strict with ReadWritePaths=<runtime root>, so /usr/local is
// read-only to it and EnsureDir's chmod fails with EROFS even when the
// directory already exists with the right mode. Serving the verbs needs the
// program present, not writable; see ProbeInstalled.
func InstallProbe() error {
	if err := fsx.EnsureDir(layout.ToolInstallDir, 0o755, fsx.Owner{UID: 0, GID: 0}); err != nil {
		return err
	}
	if err := fsx.WriteAtomic(layout.OperatorProbe, inventoryProbeScript, 0o644, fsx.Owner{UID: 0, GID: 0}); err != nil {
		return err
	}
	if err := fsx.WriteAtomic(layout.OperatorOAuthProbe, mcpOAuthProbeScript, 0o644, fsx.Owner{UID: 0, GID: 0}); err != nil {
		return err
	}
	return installA2APolicyFilesIfPresent(layout.RuntimeRoot, hermes.ServiceOwner())
}

// ProbeInstalled reports whether the interpreter program is present as a
// regular file, which the operator service checks before it claims
// `toolset_management` and `mcp_management` in its features.
func ProbeInstalled() error {
	return regularFile(layout.OperatorProbe)
}

// OAuthProbeInstalled reports whether the MCP OAuth program is present, which is what
// the operator needs to know before it claims `mcp_oauth`.
func OAuthProbeInstalled() error {
	return regularFile(layout.OperatorOAuthProbe)
}

func regularFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", path)
	}
	return nil
}

// HostProbe runs only the venv Python interpreter on the operator's own
// program. argv is the fixed program path plus one verb from a closed set;
// the request, which may carry a token, travels on stdin, never in argv.
func HostProbe(runner exec.Runner) Probe {
	return hostProbeWithCommand(runner, func(verb string) exec.Cmd {
		return account.AsUser(layout.ServiceUser, serviceEnv(), layout.VenvBin+"/python", layout.OperatorProbe, verb)
	})
}

func hostProbeWithCommand(runner exec.Runner, command func(string) exec.Cmd) Probe {
	return func(ctx context.Context, verb string, request []byte) ([]byte, error) {
		if !probeVerbs[verb] {
			return nil, fmt.Errorf("unknown probe verb %q", verb)
		}
		cmd := command(verb)
		cmd.Stdin = request
		cmd.Timeout = probeTimeout(verb)
		res, err := runner.Run(ctx, cmd)
		if err != nil {
			return nil, err
		}
		if res.ExitCode != 0 {
			return nil, errors.New("the host inventory program exited unsuccessfully")
		}
		if len(res.Stdout) == 0 || len(res.Stdout) > MaxProbeOutput {
			return nil, errors.New("the host inventory program returned an invalid response size")
		}
		return []byte(res.Stdout), nil
	}
}

var probeVerbs = map[string]bool{
	"toolsets":                   true,
	"model-context":              true,
	"mcp-inventory":              true,
	"mcp-add":                    true,
	"mcp-install":                true,
	"mcp-remove":                 true,
	"profiles":                   true,
	"profile-avatar":             true,
	"profile-create":             true,
	"profile-delete":             true,
	"profile-mcp-set":            true,
	"profile-mcp-remove":         true,
	"profile-memory-set":         true,
	"profile-toolset-suppress":   true,
	"profile-memory-get":         true,
	"profile-memory-write":       true,
	"profile-model-set":          true,
	"profile-models-set":         true,
	"profile-skill-set":          true,
	"profile-bundled-skills-set": true,
	"profile-credential-set":     true,
	"profile-credential-delete":  true,
	"profile-oauth-adopt-root":   true,
	"skills-hub-capabilities":    true,
	"skills-hub-search":          true,
	"skills-hub-refresh":         true,
	"skills-hub-inspect":         true,
	"skills-hub-scan":            true,
	"skills-hub-install":         true,
	"skills-hub-uninstall":       true,
}

// cacheableVerbs are the pure reads. A write is never cached and never
// deduplicated: two callers asking for the same change must both reach the
// host, because the second one's outcome may legitimately differ.
var cacheableVerbs = map[string]bool{"toolsets": true, "mcp-inventory": true, "profiles": true}

// parameterizedReadVerbs are reads that carry an argument. The read cache is
// keyed by verb alone and always sends `{}`, so caching one of these would
// serve one profile's answer for another. They are still reads: unlike a
// write, they must not drop the cache of the reads above.
var parameterizedReadVerbs = map[string]bool{"model-context": true}

type probeCacheEntry struct {
	document []byte
	expires  time.Time
}

type probeFlight struct {
	done     chan struct{}
	document []byte
	err      error
}

// StaleReadLimit is how long past ReadCacheTTL a read document may still be
// served at once while a background read replaces it. Opening a console
// screen a few minutes after the last one used to pay every cold interpreter
// again (4 to 5 s on the Marketplace, measured 2026-10-21 on the lab runtime).
// Our own writes still drop the cache, so a write is never followed by a stale
// read; what this widens is the window in which a change made by someone else
// at the console can hide, from one minute to one more read.
const StaleReadLimit = 10 * time.Minute

// readCached serves a read verb from the cache, joins an in-flight read, or
// starts one. The shared read survives the first caller going away: a page
// that navigates during a cold interpreter start must not leave the next
// caller to pay for it again. A document past ReadCacheTTL but within
// StaleReadLimit is served at once and refreshed in the background.
func (s *Server) readCached(ctx context.Context, verb string) ([]byte, error) {
	s.mu.Lock()
	now := s.now()
	if entry := s.probeCache[verb]; entry != nil {
		if now.Before(entry.expires) {
			document := entry.document
			s.mu.Unlock()
			return document, nil
		}
		if now.Before(entry.expires.Add(StaleReadLimit)) {
			document := entry.document
			if s.probeFlights[verb] == nil {
				s.startReadLocked(verb)
			}
			s.mu.Unlock()
			return document, nil
		}
	}
	flight := s.probeFlights[verb]
	if flight == nil {
		flight = s.startReadLocked(verb)
	}
	s.mu.Unlock()
	select {
	case <-flight.done:
		return flight.document, flight.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// startReadLocked starts the shared read of verb in the background. s.mu is
// held by the caller.
func (s *Server) startReadLocked(verb string) *probeFlight {
	flight := &probeFlight{done: make(chan struct{})}
	if s.probeFlights == nil {
		s.probeFlights = map[string]*probeFlight{}
	}
	s.probeFlights[verb] = flight
	// The generation this read was started under. A write that lands while the
	// interpreter is running bumps it, and the document below, which describes
	// the state BEFORE that write, is then served once and never cached.
	// Without this, a read that started first and finished last would pin a
	// stale inventory for a full TTL, right after the operator changed it.
	generation := s.probeGeneration
	go func() {
		probeCtx, cancel := context.WithTimeout(context.Background(), probeTimeout(verb))
		document, err := s.Probe(probeCtx, verb, []byte("{}"))
		cancel()

		s.mu.Lock()
		if err == nil && generation == s.probeGeneration {
			if s.probeCache == nil {
				s.probeCache = map[string]*probeCacheEntry{}
			}
			s.probeCache[verb] = &probeCacheEntry{document: document, expires: s.now().Add(ReadCacheTTL)}
		}
		flight.document, flight.err = document, err
		if s.probeFlights[verb] == flight {
			delete(s.probeFlights, verb)
		}
		close(flight.done)
		s.mu.Unlock()
	}()
	return flight
}

// dropReadCache forgets every cached read. Called after a write SUCCEEDS and
// after one FAILS: a failed `hermes tools` may still have rewritten the config
// before erroring, so a stale document would be the worse of the two lies.
func (s *Server) dropReadCache() {
	s.mu.Lock()
	s.probeCache = nil
	// A read in flight describes the state before this write: the next caller
	// starts its own instead of joining it.
	s.probeFlights = nil
	s.probeGeneration++
	s.mu.Unlock()
}

func probeTimeout(verb string) time.Duration {
	switch verb {
	case "toolsets", "mcp-inventory", "model-context":
		return 30 * time.Second
	case "profiles":
		return 60 * time.Second
	case "profile-avatar":
		return 20 * time.Second
	case "skills-hub-refresh":
		// A cold host downloads every hub index (the Hermes one is ~50 MB).
		return 5 * time.Minute
	default:
		return 3 * time.Minute
	}
}

// probeError is the `{"error":{code,message}}` document the program returns
// for a refusal that belongs to the contract.
type probeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *probeError) Error() string { return e.Code + ": " + e.Message }

// runProbe decodes one reply into out. A contract refusal comes back as a
// *probeError so the handler can map it to its own status.
func (s *Server) runProbe(ctx context.Context, verb string, request any, out any) error {
	if s.Probe == nil {
		return errors.New("this host does not serve the inventory verbs")
	}
	var raw []byte
	var err error
	switch {
	case cacheableVerbs[verb]:
		raw, err = s.readCached(ctx, verb)
	case parameterizedReadVerbs[verb]:
		probeCtx, cancel := context.WithTimeout(ctx, probeTimeout(verb))
		raw, err = s.invokeProbe(probeCtx, verb, request)
		cancel()
	default:
		defer s.dropReadCache()
		raw, err = s.invokeProbe(ctx, verb, request)
	}
	if err != nil {
		return err
	}
	return decodeProbe(raw, out)
}

// runFreshProbe is reserved for capability advertisement. It deliberately
// bypasses the pure-read cache so a console change to
// gateway.multiplex_profiles is reflected by the next GET /capabilities,
// while GET /profiles itself remains cacheable.
func (s *Server) runFreshProbe(ctx context.Context, verb string, request any, out any) error {
	if s.Probe == nil {
		return errors.New("this host does not serve the inventory verbs")
	}
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout(verb))
	defer cancel()
	raw, err := s.invokeProbe(probeCtx, verb, request)
	if err != nil {
		return err
	}
	return decodeProbe(raw, out)
}

func (s *Server) invokeProbe(ctx context.Context, verb string, request any) ([]byte, error) {
	body := []byte("{}")
	if request != nil {
		encoded, err := json.Marshal(request)
		if err != nil {
			return nil, err
		}
		body = encoded
	}
	return s.Probe(ctx, verb, body)
}

func decodeProbe(raw []byte, out any) error {
	var document any
	if err := json.Unmarshal(raw, &document); err != nil {
		return errors.New("the host inventory program returned invalid JSON")
	}
	if _, object := document.(map[string]any); object {
		var envelope struct {
			Error *probeError `json:"error"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return errors.New("the host inventory program returned invalid JSON")
		}
		if envelope.Error != nil {
			if envelope.Error.Code == "" {
				envelope.Error.Code = "HOST_FAILED"
			}
			return envelope.Error
		}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// probeRefusals is the CLOSED set of refusals whose message may cross to the
// link, with the status each one takes. A code outside it, such as `HOST_FAILED` or
// anything a future program invents, is reported generically: only a refusal
// this side wrote can be trusted not to carry an upstream path, URL, or
// traceback in its text.
var probeRefusals = map[string]int{
	"NAME_INVALID":                http.StatusBadRequest,
	"URL_INVALID":                 http.StatusBadRequest,
	"AUTH_INVALID":                http.StatusBadRequest,
	"SECRET_INVALID":              http.StatusBadRequest,
	"BODY_INVALID":                http.StatusBadRequest,
	"ENV_UNKNOWN":                 http.StatusBadRequest,
	"ENV_REQUIRED":                http.StatusBadRequest,
	"TOKEN_REFUSED":               http.StatusBadRequest,
	"SERVER_REFUSED":              http.StatusBadRequest,
	"OAUTH_UNSUPPORTED":           http.StatusBadRequest,
	"INSTALL_FAILED":              http.StatusBadGateway,
	"SERVER_EXISTS":               http.StatusConflict,
	"SERVER_UNKNOWN":              http.StatusNotFound,
	"CATALOG_ENTRY_UNKNOWN":       http.StatusNotFound,
	"CATALOG_UNAVAILABLE":         http.StatusNotFound,
	"RESPONSE_TOO_LARGE":          http.StatusBadGateway,
	"PROFILE_INVALID":             http.StatusBadRequest,
	"PROFILE_ENV_REFUSED":         http.StatusBadGateway,
	"PROFILE_CONFIG_REFUSED":      http.StatusBadGateway,
	"PROFILE_EXISTS":              http.StatusConflict,
	"PROFILE_NOT_FOUND":           http.StatusNotFound,
	"PROFILE_UNVERIFIED":          http.StatusBadGateway,
	"MULTIPLEX_OFF":               http.StatusServiceUnavailable,
	"MCP_SERVER_NOT_FOUND":        http.StatusNotFound,
	"AVATAR_NOT_FOUND":            http.StatusNotFound,
	"AVATAR_TOO_LARGE":            http.StatusBadGateway,
	"SKILL_INVALID":               http.StatusBadRequest,
	"SKILL_NOT_FOUND":             http.StatusNotFound,
	"PROVIDER_UNKNOWN":            http.StatusBadRequest,
	"PROVIDER_INVALID":            http.StatusBadRequest,
	"MEMORY_INVALID":              http.StatusBadRequest,
	"MEMORY_DISABLED":             http.StatusConflict,
	"MEMORY_REFUSED":              http.StatusConflict,
	"MEMORY_UNAVAILABLE":          http.StatusBadGateway,
	"SKILL_IDENTIFIER_INVALID":    http.StatusBadRequest,
	"SKILL_QUERY_INVALID":         http.StatusBadRequest,
	"SKILL_SOURCE_INVALID":        http.StatusBadRequest,
	"SKILL_LIMIT_INVALID":         http.StatusBadRequest,
	"SKILL_OPERATION_IN_PROGRESS": http.StatusConflict,
	"SKILL_OPERATION_NOT_FOUND":   http.StatusNotFound,
	"SKILL_SCAN_BLOCKED":          http.StatusForbidden,
	"SKILL_TRUST_REFUSED":         http.StatusForbidden,
	"SKILL_SCAN_FAILED":           http.StatusBadGateway,
	"SKILL_INSTALL_FAILED":        http.StatusBadGateway,
	"SKILL_INSTALL_UNVERIFIED":    http.StatusBadGateway,
	"SKILL_UNINSTALL_UNVERIFIED":  http.StatusBadGateway,
}

// writeProbeFailure maps a probe outcome to the operator's public error shape.
func (s *Server) writeProbeFailure(w http.ResponseWriter, verb string, err error) {
	var refusal *probeError
	if errors.As(err, &refusal) {
		if status, known := probeRefusals[refusal.Code]; known {
			writeError(w, status, refusal.Code, refusal.Message)
			return
		}
		s.logf("inventory verb %s refused with an out-of-contract code", verb)
		writeError(w, http.StatusBadGateway, "HOST_UNAVAILABLE", "the host could not complete this operation")
		return
	}
	s.logf("inventory verb %s failed on the host", verb)
	writeError(w, http.StatusBadGateway, "HOST_UNAVAILABLE", "the host could not complete this operation")
}
