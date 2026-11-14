package operator

import (
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
)

func (s *Server) hermesCommand(args ...string) exec.Cmd {
	if s.HermesCommand != nil {
		return s.HermesCommand(args...)
	}
	return hermes.CLI(args...)
}
