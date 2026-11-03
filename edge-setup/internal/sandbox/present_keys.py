import json, sys, pathlib

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

p = pathlib.Path(sys.argv[1])
cfg = yaml_load(p.read_text()) if p.exists() else {}
present = []
for key in json.loads(sys.argv[2]):
    node = cfg or {}
    for part in key.split("."):
        node = node.get(part) if isinstance(node, dict) else None
        if node is None:
            break
    else:
        present.append(key)
print(json.dumps(present))
