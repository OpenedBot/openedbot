package operator

import (
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

const developmentCallbackFeature = "mcp_development_callbacks"

var developmentRuntimeID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var developmentRoutinePath = regexp.MustCompile(`^/api/mcp/routines/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

// Only an installed development link can supply a loopback callback origin.
// The API never gets to select an arbitrary host or port.
func developmentCallbackOrigin(root string, owner fsx.Owner, runtimeID string) (string, error) {
	refused := errors.New("no unique development loopback link exists for this runtime")
	if !developmentRuntimeID.MatchString(runtimeID) {
		return "", refused
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() {
		return "", refused
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) > 128 {
		return "", refused
	}
	paths := []string{filepath.Join(root, "link.json")}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := layout.ParseConnectorInstance(entry.Name()); err == nil {
			paths = append(paths, filepath.Join(root, entry.Name(), "link.json"))
		}
	}
	origin := ""
	for _, path := range paths {
		if _, err := os.Lstat(path); os.IsNotExist(err) {
			continue
		}
		valid, err := fsx.RequireRegular(path, 0o600, owner)
		if err != nil || !valid {
			return "", refused
		}
		file, err := os.Open(path)
		if err != nil {
			return "", refused
		}
		data, readErr := io.ReadAll(io.LimitReader(file, 65537))
		file.Close()
		if readErr != nil || len(data) > 65536 {
			return "", refused
		}
		var link struct {
			RuntimeID   string `json:"runtime_id"`
			Openedbot   string `json:"openedbot"`
			Environment string `json:"openedbot_environment"`
		}
		if json.Unmarshal(data, &link) != nil {
			return "", refused
		}
		if link.RuntimeID != runtimeID {
			continue
		}
		u, err := url.Parse(link.Openedbot)
		if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil ||
			(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" ||
			(link.Environment != "dev" && link.Environment != "development") {
			return "", refused
		}
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 || origin != "" {
			return "", refused
		}
		origin = "http://" + u.Host
	}
	if origin == "" {
		return "", refused
	}
	return origin, nil
}

func (s *Server) resolveDevelopmentCallback(body mcpAddBody) (string, bool) {
	u, err := url.Parse(body.URL)
	if err != nil || u.Scheme != "openedbot-dev" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" ||
		body.Name != "openedbot_routines" || body.Auth != "header" || !developmentRoutinePath.MatchString(u.Path) || s.DevelopmentCallbackOrigin == nil {
		return "", false
	}
	origin, err := s.DevelopmentCallbackOrigin(u.Host)
	if err != nil {
		return "", false
	}
	return origin + u.Path, true
}
