import json, pathlib, sys

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
if path.is_symlink() or not path.is_file():
    raise SystemExit("config.yaml must be a regular non-symlink file")
config = yaml_load(path.read_text()) or {}
expected = json.loads(sys.argv[2])
valid = (
    config.get("platform_toolsets", {}).get("api_server") == expected
    and config.get("memory", {}).get("memory_enabled") is False
    and config.get("memory", {}).get("user_profile_enabled") is False
)
print("ok" if valid else "invalid")
