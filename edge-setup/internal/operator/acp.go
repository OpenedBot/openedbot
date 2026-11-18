package operator

import (
	"errors"
	"net/http"
	"os"
	"os/user"
	"strconv"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// ACPFeatures lists only the host operations implemented for this engine.
func ACPFeatures() []string { return []string{"profile_management"} }

// ACPHost constructs none of the Hermes dependencies.
func ACPHost() http.Handler {
	return acpHost(layout.ACPProfilesRoot, func() (int, int, error) {
		account, err := user.Lookup(layout.ServiceUser)
		if err != nil {
			return 0, 0, err
		}
		uid, err := strconv.Atoi(account.Uid)
		if err != nil {
			return 0, 0, err
		}
		gid, err := strconv.Atoi(account.Gid)
		return uid, gid, err
	})
}

// UserAgentHost serves the same profile operations for a user-owned runtime.
func UserAgentHost(profilesRoot string) http.Handler {
	return acpHost(profilesRoot, func() (int, int, error) { return os.Geteuid(), os.Getegid(), nil })
}

func acpHost(profilesRoot string, owner func() (int, int, error)) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /capabilities", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"features": ACPFeatures()})
	})
	mux.HandleFunc("GET /profiles", func(w http.ResponseWriter, r *http.Request) {
		root, err := os.OpenRoot(profilesRoot)
		if err != nil {
			writeError(w, 502, "HOST_UNAVAILABLE", "the profiles root could not be read")
			return
		}
		defer root.Close()
		dir, err := root.Open(".")
		if err != nil {
			writeError(w, 502, "HOST_UNAVAILABLE", "the profiles root could not be read")
			return
		}
		defer dir.Close()
		entries, err := dir.ReadDir(-1)
		if err != nil {
			writeError(w, 502, "HOST_UNAVAILABLE", "the profiles root could not be read")
			return
		}
		profiles := []HostProfile{}
		for _, entry := range entries {
			if entry.IsDir() && profileSlugRe.MatchString(entry.Name()) && entry.Name() != "default" {
				profiles = append(profiles, acpProfile(entry.Name()))
			}
		}
		writeJSON(w, 200, ProfileInventory{Multiplex: true, Profiles: profiles})
	})
	mux.HandleFunc("POST /profiles", func(w http.ResponseWriter, r *http.Request) {
		var body profileCreateBody
		if !readBody(w, r, &body) {
			return
		}
		if !profileSlugRe.MatchString(body.Name) || body.Name == "default" {
			writeError(w, 400, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
			return
		}
		if body.DisplayName != nil && (strings.TrimSpace(*body.DisplayName) == "" || len(*body.DisplayName) > 120 || hasControl(*body.DisplayName)) {
			writeError(w, 400, "PROFILE_INVALID", "displayName is too long or contains control characters")
			return
		}
		if body.Provider != nil || body.Model != nil || (body.BundledSkills != nil && *body.BundledSkills) {
			writeError(w, 400, "BODY_INVALID", "ACP does not support model or bundled skill selection")
			return
		}
		uid, gid, err := owner()
		if err != nil {
			writeError(w, 502, "HOST_UNAVAILABLE", "the service account could not be resolved")
			return
		}
		root, err := os.OpenRoot(profilesRoot)
		if err != nil {
			writeError(w, 502, "HOST_UNAVAILABLE", "the profiles root could not be opened")
			return
		}
		defer root.Close()
		if err := root.Mkdir(body.Name, 0700); err != nil {
			if errors.Is(err, os.ErrExist) {
				writeError(w, 409, "PROFILE_EXISTS", "the profile already exists")
				return
			}
			writeError(w, 502, "HOST_UNAVAILABLE", "the profile could not be created")
			return
		}
		if err := root.Chown(body.Name, uid, gid); err != nil {
			_ = root.Remove(body.Name)
			writeError(w, 502, "HOST_UNAVAILABLE", "the profile owner could not be set")
			return
		}
		if err := root.Chmod(body.Name, 0700); err != nil {
			_ = root.Remove(body.Name)
			writeError(w, 502, "HOST_UNAVAILABLE", "the profile permissions could not be set")
			return
		}
		info, err := root.Stat(body.Name)
		if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
			writeError(w, 502, "PROFILE_UNVERIFIED", "the profile could not be read back")
			return
		}
		writeJSON(w, 201, map[string]any{"profile": acpProfile(body.Name), "readBack": readBackProfile})
	})
	mux.HandleFunc("DELETE /profiles/{slug}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("slug")
		if !profileSlugRe.MatchString(name) || name == "default" {
			writeError(w, 400, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
			return
		}
		root, err := os.OpenRoot(profilesRoot)
		if err != nil {
			writeError(w, 502, "HOST_UNAVAILABLE", "the profiles root could not be opened")
			return
		}
		defer root.Close()
		if _, err := root.Lstat(name); errors.Is(err, os.ErrNotExist) {
			writeError(w, 404, "PROFILE_NOT_FOUND", "the profile does not exist")
			return
		}
		if err := root.RemoveAll(name); err != nil {
			writeError(w, 502, "HOST_UNAVAILABLE", "the profile could not be deleted")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	return strictPath(mux)
}

func acpProfile(name string) HostProfile {
	return HostProfile{Name: name, DisplayName: name, Routines: []ProfileRoutine{}, Skills: []ProfileNamedFlag{}, Toolsets: []ProfileNamedFlag{}, MCPServers: []ProfileMCPServer{}}
}
