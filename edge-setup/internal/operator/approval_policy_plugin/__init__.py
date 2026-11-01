import hashlib
import json
import posixpath
import re
from pathlib import Path

# PERM2-A: every gate names its tool (`rule_key`, which Hermes turns into
# `pattern_key = "plugin_rule:ohb/v1/<tool_key>"`) and ends its message with
# one descriptor line, `ohb-gate/v1 <sha256 of the JSON text> <JSON>`. The
# twin reader is `modules/execution/src/domain/gate-identity.ts` in openedbot: a
# change here changes it there. The descriptor carries only what the
# permission pipeline needs, never a file content, and fits in 1 KiB.
RULE_PREFIX = "ohb/v1/"
DESCRIPTOR_VERSION = 1
DESCRIPTOR_MAX_BYTES = 1024
PATH_MAX_CHARS = 512
MAX_PATCH_ENTRIES = 16
NATIVE_WRITE_TOOLS = ("write_file", "patch", "skill_manage", "execute_code", "send_message", "cronjob")
MCP_PART_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
MCP_SERVER_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
# `tools/file_tools.py` (`_V4A_SINGLE_HEADER_RE`, `_V4A_MOVE_HEADER_RE`).
V4A_SINGLE_HEADER_RE = re.compile(r"^\*\*\*\s*(Update|Add|Delete)\s+File:\s*(.+)$", re.MULTILINE)
V4A_MOVE_HEADER_RE = re.compile(r"^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)$", re.MULTILINE)


def _args_digest(args):
    try:
        text = json.dumps(args, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    except Exception:
        text = repr(args)
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def _path(value):
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = posixpath.normpath(value.strip())
    return normalized if len(normalized) <= PATH_MAX_CHARS else None


def _text(value, limit):
    return value if isinstance(value, str) and 0 < len(value) <= limit else None


def _mcp_names(tool_name):
    """(server, tool) of a registered MCP tool, or None when unprovable.

    Hermes names it `mcp__<sanitized server>__<sanitized tool>`
    (`tools/mcp_tool_schema.py`); older runtimes used single underscores. A
    server name may hold underscores, so the registry's own toolset
    (`mcp-<server>`) decides where the server ends.
    """
    try:
        from tools.registry import registry

        toolset = registry.get_toolset_for_tool(tool_name)
    except Exception:
        return None
    if not isinstance(toolset, str) or not toolset.startswith("mcp-"):
        return None
    server = toolset[len("mcp-"):]
    sanitized = re.sub(r"[^A-Za-z0-9_]", "_", server)
    for head in (f"mcp__{sanitized}__", f"mcp_{sanitized}_"):
        if tool_name.startswith(head):
            tool = tool_name[len(head):]
            if MCP_SERVER_RE.match(server) and MCP_PART_RE.match(tool):
                return server, tool
    return None


def _redacted_arguments(args):
    """The MCP arguments as Hermes would display them, or None when unsure."""
    try:
        from agent.redact import redact_sensitive_text

        return json.loads(redact_sensitive_text(json.dumps(args, ensure_ascii=False, default=str), force=True))
    except Exception:
        return None


def _patch_descriptor(args):
    if args.get("mode", "replace") == "replace":
        path = _path(args.get("path"))
        return ("no", {"paths": [path], "ops": ["replace"]}) if path else None
    patch = args.get("patch")
    if not isinstance(patch, str):
        return None
    entries = [(op.lower(), raw) for op, raw in V4A_SINGLE_HEADER_RE.findall(patch)]
    entries += [("move", raw) for pair in V4A_MOVE_HEADER_RE.findall(patch) for raw in pair]
    if not entries or len(entries) > MAX_PATCH_ENTRIES:
        return None
    paths = [_path(raw) for _, raw in entries]
    if any(path is None for path in paths):
        return None
    ops = sorted({op for op, _ in entries})
    return ("yes" if "delete" in ops else "no", {"paths": paths, "ops": ops})


def describe(tool_name, args):
    """(tool_key, deletes, opaque, described args), or None: no identity."""
    args = args if isinstance(args, dict) else {}
    if tool_name == "write_file":
        path, content = _path(args.get("path")), args.get("content")
        if path is None or not isinstance(content, str):
            return None
        return tool_name, "yes" if content == "" else "no", False, {"path": path, "size": len(content)}
    if tool_name == "patch":
        described = _patch_descriptor(args)
        # A patch we cannot read may delete: opaque, decided by a human.
        if described is None:
            return tool_name, "unknown", True, {"paths": [], "ops": []}
        return tool_name, described[0], False, described[1]
    if tool_name == "skill_manage":
        action = _text(args.get("action"), 32)
        if action is None:
            return None
        described = {"action": action}
        if _text(args.get("name"), 128):
            described["name"] = args["name"]
        return tool_name, "yes" if action == "delete" else "no", False, described
    if tool_name == "send_message":
        action = _text(args.get("action", "send"), 32)
        if action is None:
            return None
        described = {"action": action}
        target = _text(args.get("target"), 256)
        if target:
            described["target"] = target
            described["platform"] = target.split(":", 1)[0][:32] or "unknown"
        return tool_name, "no", False, described
    if tool_name == "execute_code":
        code = args.get("code")
        return tool_name, "unknown", True, {"language": "python", "size": len(code) if isinstance(code, str) else 0}
    if tool_name == "cronjob":
        return tool_name, "unknown", False, {}
    names = _mcp_names(tool_name)
    if names is None:
        return None
    server, tool = names
    # Hermes keeps no `destructiveHint` of an MCP tool: never `no`.
    return f"mcp:{server}:{tool}", "unknown", False, {"server": server, "tool": tool, "arguments": _redacted_arguments(args)}


def descriptor_line(tool_key, deletes, opaque, described, digest):
    body = {"v": DESCRIPTOR_VERSION, "tool": tool_key, "deletes": deletes, "opaque": opaque, "digest": digest, "args": described}
    if body["args"].get("arguments", "") is None:
        del body["args"]["arguments"]
        body["opaque"] = True
    text = json.dumps(body, separators=(",", ":"), ensure_ascii=True)
    if len(text.encode("utf-8")) > DESCRIPTOR_MAX_BYTES and tool_key.startswith("mcp:"):
        # Arguments too large to describe whole: opaque, never cut.
        body["args"].pop("arguments", None)
        body["opaque"] = True
        text = json.dumps(body, separators=(",", ":"), ensure_ascii=True)
    if len(text.encode("utf-8")) > DESCRIPTOR_MAX_BYTES:
        return None
    return f"ohb-gate/v1 {hashlib.sha256(text.encode('utf-8')).hexdigest()} {text}"


def register(ctx):
    policy_path = Path(__file__).parent / "policy.json"

    def before_tool(tool_name: str, **kwargs):
        try:
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            mode = policy.get("mode")
            blocked = policy.get("blocked_tools", [])
        except Exception:
            mode, blocked = "ask_writes", []
        if mode not in ("ask_writes", "block_writes", "off"):
            mode = "ask_writes"
        # An unreadable list blocks nothing more, and asks like any write.
        blocked = set(blocked) if isinstance(blocked, list) and all(isinstance(key, str) for key in blocked) else set()
        if mode == "off" or not (tool_name in NATIVE_WRITE_TOOLS or tool_name.startswith("mcp_")):
            return None
        if mode == "block_writes":
            return {"action": "block", "message": f"Blocked {tool_name}: this bot is in plan mode."}
        args = kwargs.get("args")
        try:
            described = describe(tool_name, args)
        except Exception:
            described = None
        if described is not None and described[0] in blocked:
            return {"action": "block", "message": f"Blocked {tool_name}: this tool is blocked for this bot."}
        sentence = f"Approve write-capable tool {tool_name}."
        if described is None:
            # No provable identity: Hermes keys the gate on the tool name and
            # openedbot reads it as `unknown`, which a human decides.
            return {"action": "approve", "message": sentence}
        tool_key, deletes, opaque, described_args = described
        line = descriptor_line(tool_key, deletes, opaque, described_args, _args_digest(args))
        if line is None:
            return {"action": "approve", "message": sentence}
        return {"action": "approve", "message": f"{sentence}\n{line}", "rule_key": RULE_PREFIX + tool_key}

    ctx.register_hook("pre_tool_call", before_tool)
