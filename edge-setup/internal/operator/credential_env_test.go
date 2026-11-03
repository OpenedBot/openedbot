package operator

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
)

type credentialRunnerFunc func(context.Context, exec.Cmd) (exec.Result, error)

func (fn credentialRunnerFunc) Run(ctx context.Context, cmd exec.Cmd) (exec.Result, error) {
	return fn(ctx, cmd)
}

func writeCredentialFixture(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal("could not create temporary credential directory")
	}
	if err := fsx.WriteAtomic(path, []byte(contents), 0o600, fsx.Current()); err != nil {
		t.Fatal("could not write private credential fixture")
	}
}

func postOperatorJSON(t *testing.T, server *Server, path, body string) (int, map[string]any) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal("operator returned invalid JSON")
	}
	return response.Code, result
}

func readCredentialFixture(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("credential fixture could not be read")
	}
	return string(data)
}

func TestRootCredentialWriteUsesInjectedRuntimeStoreAndMirrorsOnlyChangedProviderKeys(t *testing.T) {
	root := t.TempDir()
	store := hermes.EnvStore{Root: root, Owner: fsx.Current()}
	writeCredentialFixture(t, filepath.Join(root, ".env"), "API_SERVER_KEY=local-runtime-token\nANTHROPIC_API_KEY=root-old\n")
	writeCredentialFixture(t, filepath.Join(root, "profiles", "personal", ".env"), "ANTHROPIC_API_KEY=personal-owned\nKEEP=personal\n")
	writeCredentialFixture(t, filepath.Join(root, "profiles", "personal", ".env.ohb-own"), "ANTHROPIC_API_KEY\n")
	writeCredentialFixture(t, filepath.Join(root, "profiles", "team", ".env"), "KEEP=team\n")

	const submittedKey = "fixture-api-key-not-a-real-credential"
	const persistedKey = "fixture-provider-key-from-fake-cli"
	commandPath := filepath.Join(root, "venv", "bin", "hermes")
	var calls int
	runner := credentialRunnerFunc(func(_ context.Context, cmd exec.Cmd) (exec.Result, error) {
		calls++
		if cmd.Path != commandPath || strings.Contains(cmd.String(), submittedKey) || string(cmd.Stdin) != submittedKey+"\n" {
			t.Error("root credential was not sent only through the fixed CLI stdin")
		}
		for _, value := range cmd.Env {
			if strings.Contains(value, submittedKey) {
				t.Error("root credential appeared in the CLI environment")
			}
		}
		writeCredentialFixture(t, filepath.Join(root, ".env"), "API_SERVER_KEY=local-runtime-token\nANTHROPIC_API_KEY="+persistedKey+"\nEXTRA_PROVIDER_KEY=fixture-extra\n")
		return exec.Result{}, nil
	})
	server := &Server{
		Runner:        runner,
		CredentialEnv: store,
		HermesCommand: func(args ...string) exec.Cmd { return exec.Cmd{Path: commandPath, Args: args} },
		Catalogue: func(context.Context) ([]byte, error) {
			return []byte(`{"providers":[{"slug":"anthropic","authenticated":true}]}`), nil
		},
	}
	status, result := postOperatorJSON(t, server, "/providers/anthropic/credentials", `{"apiKey":"`+submittedKey+`","label":"ohb-scope"}`)
	if status != http.StatusOK || result["verification"] != "confirmed" || calls != 1 {
		t.Fatal("root credential write was not confirmed through the configured runtime")
	}
	if got := readCredentialFixture(t, filepath.Join(root, "profiles", "personal", ".env")); !strings.Contains(got, "ANTHROPIC_API_KEY=personal-owned") || !strings.Contains(got, "EXTRA_PROVIDER_KEY=fixture-extra") {
		t.Fatal("root mirroring did not preserve profile-owned keys and copy unowned changes")
	}
	teamEnv := readCredentialFixture(t, filepath.Join(root, "profiles", "team", ".env"))
	if !strings.Contains(teamEnv, "ANTHROPIC_API_KEY="+persistedKey) || !strings.Contains(teamEnv, "EXTRA_PROVIDER_KEY=fixture-extra") || strings.Contains(teamEnv, "API_SERVER_KEY=") {
		t.Fatal("root mirroring escaped its changed provider-key scope")
	}
}

func TestProfileCredentialWriteMarksItsOwnKeyInInjectedRuntimeStore(t *testing.T) {
	root := t.TempDir()
	store := hermes.EnvStore{Root: root, Owner: fsx.Current()}
	writeCredentialFixture(t, filepath.Join(root, ".env"), "ANTHROPIC_API_KEY=root-old\n")
	profileEnv := filepath.Join(root, "profiles", "scout", ".env")
	writeCredentialFixture(t, profileEnv, "ANTHROPIC_API_KEY=profile-old\nKEEP=profile\n")
	writeCredentialFixture(t, filepath.Join(root, "profiles", "other", ".env"), "KEEP=other\n")

	const submittedKey = "fixture-profile-key-not-a-real-credential"
	const persistedKey = "fixture-profile-key-from-fake-cli"
	commandPath := filepath.Join(root, "venv", "bin", "hermes")
	var calls int
	runner := credentialRunnerFunc(func(_ context.Context, cmd exec.Cmd) (exec.Result, error) {
		calls++
		if cmd.Path != commandPath || strings.Contains(cmd.String(), submittedKey) || string(cmd.Stdin) != submittedKey+"\n" {
			t.Error("profile credential was not sent only through the fixed CLI stdin")
		}
		for _, value := range cmd.Env {
			if strings.Contains(value, submittedKey) {
				t.Error("profile credential appeared in the CLI environment")
			}
		}
		writeCredentialFixture(t, profileEnv, "ANTHROPIC_API_KEY="+persistedKey+"\nKEEP=profile\n")
		return exec.Result{}, nil
	})
	server := &Server{
		Runner:        runner,
		CredentialEnv: store,
		HermesCommand: func(args ...string) exec.Cmd { return exec.Cmd{Path: commandPath, Args: args} },
		ProfileCatalogue: func(context.Context, string) ([]byte, error) {
			return []byte(`{"providers":[{"slug":"anthropic","authenticated":true}]}`), nil
		},
	}
	status, result := postOperatorJSON(t, server, "/profiles/scout/providers/anthropic/credentials", `{"apiKey":"`+submittedKey+`","label":"ohb-profile"}`)
	if status != http.StatusOK || result["verification"] != "confirmed" || calls != 1 {
		t.Fatal("profile credential write was not confirmed on the named profile")
	}
	marker := readCredentialFixture(t, filepath.Join(root, "profiles", "scout", ".env.ohb-own"))
	if !strings.Contains(marker, "ANTHROPIC_API_KEY") {
		t.Fatal("profile credential write did not mark the changed key as profile-owned")
	}
	if err := store.MirrorRuntimeEnvDelta(map[string]string{"ANTHROPIC_API_KEY": "root-old"}, map[string]string{"ANTHROPIC_API_KEY": "root-new"}); err != nil {
		t.Fatal("later root mirror failed with a valid profile marker")
	}
	if got := readCredentialFixture(t, profileEnv); !strings.Contains(got, "ANTHROPIC_API_KEY="+persistedKey) {
		t.Fatal("later root mirroring overwrote the profile-owned credential")
	}
	if got := readCredentialFixture(t, filepath.Join(root, "profiles", "other", ".env")); !strings.Contains(got, "ANTHROPIC_API_KEY=root-new") {
		t.Fatal("profile ownership marker affected a different profile")
	}
}

type credentialEnvStub struct {
	rootSnapshots    []map[string]string
	profileSnapshots []map[string]string
	rootErr          error
	profileErr       error
	mirrorErr        error
	preserveErr      error
	rootCalls        int
	profileCalls     int
	mirrorCalls      int
	preserveCalls    int
}

func (s *credentialEnvStub) SnapshotRootEnv() (map[string]string, error) {
	s.rootCalls++
	if s.rootErr != nil {
		return nil, s.rootErr
	}
	index := min(s.rootCalls-1, len(s.rootSnapshots)-1)
	if index < 0 {
		return map[string]string{}, nil
	}
	return s.rootSnapshots[index], nil
}

func (s *credentialEnvStub) SnapshotProfileEnv(string) (map[string]string, error) {
	s.profileCalls++
	if s.profileErr != nil {
		return nil, s.profileErr
	}
	index := min(s.profileCalls-1, len(s.profileSnapshots)-1)
	if index < 0 {
		return map[string]string{}, nil
	}
	return s.profileSnapshots[index], nil
}

func (s *credentialEnvStub) MirrorRuntimeEnvDelta(map[string]string, map[string]string) error {
	s.mirrorCalls++
	return s.mirrorErr
}

func (s *credentialEnvStub) PreserveOwnProfileKeys(string, map[string]string, map[string]string) error {
	s.preserveCalls++
	return s.preserveErr
}

func TestCredentialEnvironmentErrorsFailClosedWithoutLeakingKeys(t *testing.T) {
	const submittedKey = "fixture-key-fail-closed-not-a-real-credential"
	commandPath := filepath.Join(t.TempDir(), "hermes")
	newServer := func(env *credentialEnvStub, calls *int) *Server {
		return &Server{
			Runner: credentialRunnerFunc(func(context.Context, exec.Cmd) (exec.Result, error) {
				*calls++
				return exec.Result{}, nil
			}),
			CredentialEnv: env,
			HermesCommand: func(args ...string) exec.Cmd { return exec.Cmd{Path: commandPath, Args: args} },
			Catalogue: func(context.Context) ([]byte, error) {
				return []byte(`{"providers":[{"slug":"anthropic","authenticated":true}]}`), nil
			},
			ProfileCatalogue: func(context.Context, string) ([]byte, error) {
				return []byte(`{"providers":[{"slug":"anthropic","authenticated":true}]}`), nil
			},
		}
	}
	assertGenericFailure := func(t *testing.T, server *Server, path string, calls *int, wantCalls int) {
		t.Helper()
		status, result := postOperatorJSON(t, server, path, `{"apiKey":"`+submittedKey+`","label":"ohb-fail"}`)
		encoded, err := json.Marshal(result)
		if err != nil {
			t.Fatal("operator error response could not be inspected")
		}
		if status != http.StatusBadGateway || strings.Contains(string(encoded), submittedKey) || *calls != wantCalls {
			t.Fatal("credential environment error did not fail closed with a generic response")
		}
	}

	t.Run("root snapshot fails before CLI", func(t *testing.T) {
		env := &credentialEnvStub{rootErr: errors.New("fixture snapshot refusal")}
		calls := 0
		assertGenericFailure(t, newServer(env, &calls), "/providers/anthropic/credentials", &calls, 0)
	})
	t.Run("root mirror failure is reported", func(t *testing.T) {
		env := &credentialEnvStub{rootSnapshots: []map[string]string{{"ANTHROPIC_API_KEY": "old"}, {"ANTHROPIC_API_KEY": "new"}}, mirrorErr: errors.New("fixture mirror refusal")}
		calls := 0
		server := newServer(env, &calls)
		status, result := postOperatorJSON(t, server, "/providers/anthropic/credentials", `{"apiKey":"`+submittedKey+`","label":"ohb-fail"}`)
		encoded, _ := json.Marshal(result)
		if status != http.StatusBadGateway || strings.Contains(string(encoded), submittedKey) || calls != 1 || env.mirrorCalls != 1 {
			t.Fatal("root mirror error did not fail closed with a generic response")
		}
	})
	t.Run("profile snapshot fails before CLI", func(t *testing.T) {
		env := &credentialEnvStub{profileErr: errors.New("fixture profile snapshot refusal")}
		calls := 0
		assertGenericFailure(t, newServer(env, &calls), "/profiles/scout/providers/anthropic/credentials", &calls, 0)
	})
	t.Run("profile own marker failure is reported", func(t *testing.T) {
		env := &credentialEnvStub{profileSnapshots: []map[string]string{{"ANTHROPIC_API_KEY": "old"}, {"ANTHROPIC_API_KEY": "new"}}, preserveErr: errors.New("fixture marker refusal")}
		calls := 0
		server := newServer(env, &calls)
		status, result := postOperatorJSON(t, server, "/profiles/scout/providers/anthropic/credentials", `{"apiKey":"`+submittedKey+`","label":"ohb-fail"}`)
		encoded, _ := json.Marshal(result)
		if status != http.StatusBadGateway || strings.Contains(string(encoded), submittedKey) || calls != 1 || env.preserveCalls != 1 {
			t.Fatal("profile ownership marker error did not fail closed with a generic response")
		}
	})
}
