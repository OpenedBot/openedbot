package operator

import "github.com/OpenedBot/openedbot/edge-setup/internal/hermes"

// CredentialEnv confines credential changes to one host runtime. A profile
// name is a validated Hermes slug, not a connector instance or a file path.
type CredentialEnv interface {
	SnapshotRootEnv() (map[string]string, error)
	SnapshotProfileEnv(string) (map[string]string, error)
	MirrorRuntimeEnvDelta(map[string]string, map[string]string) error
	PreserveOwnProfileKeys(string, map[string]string, map[string]string) error
}

func (s *Server) snapshotRootEnv() (map[string]string, error) {
	if s.CredentialEnv != nil {
		return s.CredentialEnv.SnapshotRootEnv()
	}
	return hermes.SnapshotRuntimeEnv()
}

func (s *Server) snapshotProfileEnv(profile string) (map[string]string, error) {
	if s.CredentialEnv != nil {
		return s.CredentialEnv.SnapshotProfileEnv(profile)
	}
	return hermes.SnapshotNamedProfileEnv(profile)
}

func (s *Server) mirrorCredentialEnv(before map[string]string) error {
	if s.CredentialEnv == nil {
		return mirrorCredentialEnv(before)
	}
	after, err := s.CredentialEnv.SnapshotRootEnv()
	if err != nil {
		return err
	}
	return s.CredentialEnv.MirrorRuntimeEnvDelta(before, after)
}

func (s *Server) markProfileOwnEnv(profile string, before, after map[string]string) error {
	if s.CredentialEnv != nil {
		return s.CredentialEnv.PreserveOwnProfileKeys(profile, before, after)
	}
	return hermes.MarkNamedProfileOwnEnvDelta(profile, before, after)
}
