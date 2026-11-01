package assets

import (
	"embed"
	"io/fs"
	"path"
)

//go:embed hermes-plugins/ohb_a2a_policy/plugin.yaml hermes-plugins/ohb_a2a_policy/*.py hermes-hooks/ohb_a2a_policy/HOOK.yaml hermes-hooks/ohb_a2a_policy/handler.py hermes-hooks/ohb_backend_probe/HOOK.yaml hermes-hooks/ohb_backend_probe/handler.py hermes-hooks/ohb_prompt_cache_ttl/HOOK.yaml hermes-hooks/ohb_prompt_cache_ttl/handler.py
var a2aFiles embed.FS

// A2APolicyFiles returns only the shipped companion code and the gateway
// hooks of the runtime root: the A2A startup hook, the backend probe hook
// (ohb_backend_probe, prompt latency) and the per-run prompt-cache tier
// (ohb_prompt_cache_ttl). Tests, caller paths and downloaded plugins never
// enter this inventory.
func A2APolicyFiles() (map[string][]byte, error) {
	files := make(map[string][]byte)
	err := fs.WalkDir(a2aFiles, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := a2aFiles.ReadFile(name)
		if err != nil {
			return err
		}
		files[path.Clean(name)] = append([]byte(nil), data...)
		return nil
	})
	return files, err
}
