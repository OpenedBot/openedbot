import fcntl
import hashlib
import json
import os
import posixpath
import re
import time
import uuid
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


# YOLO lease (docs/CONNECTOR.md, « Bail YOLO »). The connector verifies the
# signed lease; the operator writes the leases covering this profile into
# yolo.json, and the shared rules into hardline.json, next to this file. Both
# are re-read at every call: a lease expires here even when the connector is
# dead, `edge-setup yolo off` removes the file, and anything unreadable,
# expired or malformed falls back to ask_writes (fail closed). Under a lease a
# write passes after the hardline, the deny-list and the protections, once it
# is appended to yolo-audit.jsonl; if that append fails, it is asked instead.
YOLO_FILE = "yolo.json"
HARDLINE_FILE = "hardline.json"
SPOOL_FILE = "yolo-audit.jsonl"
TERMINAL_TOOLS = ("terminal",)
SCOPE_RANK = {"thread": 3, "bot": 2, "runtime": 1}
_COMMAND_SEPARATORS = re.compile(r"[\"'`;&|<>()=\s]+")
_SEGMENT_SPLIT = re.compile(r"\s*(?:&&|\|\||[;\n|]|\$\(|`)\s*")
_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_rules_cache = {}


def _rules(directory):
    """The compiled hardline.json, cached on its signature; None when unusable."""
    path = directory / HARDLINE_FILE
    try:
        stat = path.stat()
        key = (stat.st_mtime_ns, stat.st_size)
        if _rules_cache.get("key") == key:
            return _rules_cache["rules"]
        doc = json.loads(path.read_text(encoding="utf-8"))
        if doc.get("version") != 1:
            return None
        hard = doc["hardline"]
        rules = {
            "tools": [str(name) for name in hard["tools"]],
            "paths": [(rule["id"], re.compile(rule["pattern"])) for rule in hard["paths"]],
            "commands": [(rule["id"], re.compile(rule["pattern"])) for rule in hard["commands"]],
            "protect": {
                pid: ([re.compile(p) for p in spec.get("paths", [])], [re.compile(p) for p in spec.get("commands", [])])
                for pid, spec in doc["protect"].items()
            },
            "default": [str(pid) for pid in doc["defaultProtect"]],
        }
    except Exception:
        return None
    _rules_cache.update(key=key, rules=rules)
    return rules


def _lease(directory, profile, session_id, now):
    """The lease of yolo.json covering this call, or None (no lease, or doubt)."""
    try:
        doc = json.loads((directory / YOLO_FILE).read_text(encoding="utf-8"))
        if doc.get("v") != 1 or not isinstance(doc.get("leases"), list):
            return None
        session_key = hashlib.sha256(session_id.encode("utf-8")).hexdigest() if isinstance(session_id, str) and session_id else None
        best = None
        for lease in doc["leases"]:
            scope = lease["scope"]
            if not (int(lease["notBefore"]) <= now < int(lease["expiresAt"])):
                continue
            if scope == "thread":
                covers = lease["profile"] == profile and session_key is not None and lease["sessionKey"] == session_key
            elif scope == "bot":
                covers = lease["profile"] == profile
            else:
                covers = scope == "runtime"
            deny = lease["deny"]
            if not covers or not isinstance(lease["protect"], list) or not all(isinstance(deny[k], list) for k in ("commands", "tools", "paths")):
                continue
            if best is None or (SCOPE_RANK[scope], lease["expiresAt"]) > (SCOPE_RANK[best["scope"]], best["expiresAt"]):
                best = lease
        return best
    except Exception:
        return None


def _shell_words(text):
    """Words split on spaces and tabs, quotes removed; None on an open quote."""
    words, current, quote = [], "", None
    for char in text:
        if quote:
            if char == quote:
                quote = None
            else:
                current += char
        elif char in ("'", '"'):
            quote = char
        elif char in (" ", "\t"):
            if current:
                words.append(current)
            current = ""
        else:
            current += char
    if quote:
        return None
    if current:
        words.append(current)
    return words


def _command_denied(command, blocklist):
    """True / False, or None when the command cannot be read."""
    patterns = [words for words in (_shell_words(entry.strip()) for entry in blocklist) if words]
    for segment in _SEGMENT_SPLIT.split(command):
        segment = segment.strip()
        if not segment:
            continue
        words = _shell_words(segment)
        if words is None:
            return None
        start = 0
        while start < len(words) and _ASSIGNMENT.match(words[start]):
            start += 1
        if start < len(words) and words[start] in ("sudo", "command"):
            start += 1
        head = list(words[start:])
        if head:
            head[0] = head[0].rsplit("/", 1)[-1]
        if any(pattern == head[: len(pattern)] for pattern in patterns):
            return True
    return False


def _deny_path(path, entry):
    def trim(value):
        return value.rstrip("/") if len(value) > 1 else value

    target, denied = trim(path), trim(entry)
    if not denied:
        return False
    if target == denied or target.startswith("/" if denied == "/" else denied + "/"):
        return True
    return ("/" + denied.lstrip("/") + "/") in ("/" + target + "/")


def _yolo_verdict(rules, lease, tool_key, paths, command):
    """None lets the gate pass; otherwise why it is refused (same order as openedbot)."""
    if tool_key and tool_key in rules["tools"]:
        return f"hardline tool:{tool_key}"
    for rule_id, regex in rules["paths"]:
        if any(regex.search(path) for path in paths):
            return f"hardline {rule_id}"
    if command is not None:
        for rule_id, regex in rules["commands"]:
            if regex.search(command):
                return f"hardline {rule_id}"
        words = [word for word in _COMMAND_SEPARATORS.split(command) if word]
        for rule_id, regex in rules["paths"]:
            if any(regex.search(word) for word in words):
                return f"hardline {rule_id}"
    deny = lease["deny"]
    if tool_key and tool_key in deny["tools"]:
        return "organization deny-list"
    if any(_deny_path(path, entry) for path in paths for entry in deny["paths"]):
        return "organization deny-list"
    if command is not None and deny["commands"]:
        hit = _command_denied(command, deny["commands"])
        if hit is None:
            return "unreadable command"
        if hit:
            return "organization deny-list"
    for pid in dict.fromkeys(rules["default"] + list(lease["protect"])):
        spec = rules["protect"].get(pid)
        if spec is None:
            continue
        if any(regex.search(path) for regex in spec[0] for path in paths):
            return f"protected {pid}"
        if command is not None and any(regex.search(command) for regex in spec[1]):
            return f"protected {pid}"
    return None


def _record(directory, lease, tool_key, digest, now):
    """Append one auto-approval to the spool, durably; False when it could not be."""
    line = json.dumps({
        "v": 1, "eventId": str(uuid.uuid4()), "occurredAt": now, "leaseId": lease["leaseId"],
        "gateKind": "plugin_tool", "toolKey": tool_key, "argsHash": digest,
    }, separators=(",", ":")) + "\n"
    path = directory / SPOOL_FILE
    try:
        for _ in range(3):
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                # The connector renames the spool under this same lock: write
                # only into the file still at the path.
                if os.fstat(fd).st_ino != os.stat(path, follow_symlinks=False).st_ino:
                    continue
                os.write(fd, line.encode("utf-8"))
                os.fsync(fd)
                return True
            finally:
                os.close(fd)
    except Exception:
        return False
    return False


def _paths(described):
    if described is None:
        return []
    args = described[3]
    paths = [args["path"]] if isinstance(args.get("path"), str) else []
    paths += [path for path in args.get("paths", []) if isinstance(path, str)]
    return paths


def register(ctx):
    directory = Path(__file__).parent
    policy_path = directory / "policy.json"
    # <root>/profiles/<slug>/plugins/ohb_approval_policy
    profile = directory.parent.parent.name

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
        gated = tool_name in NATIVE_WRITE_TOOLS or tool_name.startswith("mcp_")
        if mode == "off" or not (gated or tool_name in TERMINAL_TOOLS):
            return None
        if mode == "block_writes":
            return {"action": "block", "message": f"Blocked {tool_name}: this bot is in plan mode."} if gated else None
        args = kwargs.get("args")
        now = int(time.time())
        lease = _lease(directory, profile, kwargs.get("session_id"), now)
        if not gated:
            # A terminal command is not gated here; under a lease it is checked
            # before Hermes' own approval, which the connector answers.
            rules = _rules(directory) if lease is not None else None
            command = args.get("command") if isinstance(args, dict) else None
            if rules is None or not isinstance(command, str):
                return None
            reason = _yolo_verdict(rules, lease, None, [], command)
            return {"action": "block", "message": f"Blocked {tool_name} under a YOLO lease: {reason}."} if reason else None
        try:
            described = describe(tool_name, args)
        except Exception:
            described = None
        if described is not None and described[0] in blocked:
            return {"action": "block", "message": f"Blocked {tool_name}: this tool is blocked for this bot."}
        # A gate without identity, or a patch nobody can read, is a human's.
        rules = _rules(directory) if lease is not None and described is not None and not (tool_name == "patch" and described[2]) else None
        if rules is not None:
            code = args.get("code") if tool_name == "execute_code" and isinstance(args, dict) and isinstance(args.get("code"), str) else None
            reason = _yolo_verdict(rules, lease, described[0], _paths(described), code)
            if reason:
                return {"action": "block", "message": f"Blocked {tool_name} under a YOLO lease: {reason}."}
            if _record(directory, lease, described[0], _args_digest(args), now):
                return None
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
