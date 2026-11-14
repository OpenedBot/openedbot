import json, os, pathlib, stat, sys, tempfile

# Hermes 0.22 ships ruamel.yaml instead of PyYAML in its venv; older pins
# ship PyYAML. Both are read and written through these two helpers.
try:
    import yaml as _pyyaml

    def yaml_load(text):
        return _pyyaml.safe_load(text)

    def yaml_dump(data):
        return _pyyaml.safe_dump(data, sort_keys=False, allow_unicode=True)
except ImportError:
    import io as _io
    from ruamel.yaml import YAML as _YAML

    def yaml_load(text):
        return _YAML(typ="safe", pure=True).load(text)

    def yaml_dump(data):
        dumper = _YAML(typ="safe", pure=True)
        dumper.default_flow_style = False
        dumper.allow_unicode = True
        dumper.sort_base_mapping_type_on_output = False
        buffer = _io.StringIO()
        dumper.dump(data, buffer)
        return buffer.getvalue()


path = pathlib.Path(sys.argv[1])
desired = json.loads(sys.argv[2])
if path.is_symlink() or (path.exists() and not path.is_file()):
    raise SystemExit("config.yaml must be a regular non-symlink file")
current = yaml_load(path.read_text()) if path.exists() else {}
if current is None:
    current = {}
if not isinstance(current, dict):
    raise SystemExit("config.yaml root must be a mapping")

platform = current.setdefault("platform_toolsets", {})
memory = current.setdefault("memory", {})
if not isinstance(platform, dict) or not isinstance(memory, dict):
    raise SystemExit("platform_toolsets and memory must be mappings")

changed = (
    platform.get("api_server") != desired
    or memory.get("memory_enabled") is not False
    or memory.get("user_profile_enabled") is not False
)
if changed:
    platform["api_server"] = desired
    memory["memory_enabled"] = False
    memory["user_profile_enabled"] = False
    rendered = yaml_dump(current)
    previous = path.stat() if path.exists() else None
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".config.yaml.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IMODE(previous.st_mode) if previous else 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
print("changed" if changed else "unchanged")
