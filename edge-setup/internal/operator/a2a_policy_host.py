import json, os, sys
from pathlib import Path
from hermes_cli.config import get_config_path, get_env_path, load_config, load_env, save_config, save_env_value

home_raw = os.environ.get("HERMES_HOME", "")
if not home_raw:
    raise SystemExit(2)
home = Path(home_raw).absolute()
if Path(get_config_path()).absolute() != home / "config.yaml":
    raise SystemExit(2)
if Path(get_env_path()).absolute() != home / ".env":
    raise SystemExit(2)

def read_policy():
    env = load_env() or {}
    cfg = load_config() or {}
    if not isinstance(cfg, dict):
        raise SystemExit(3)
    section = cfg.get("a2a", {})
    if section is None:
        section = {}
    if not isinstance(section, dict):
        raise SystemExit(3)
    peers = section.get("trusted_peers", [])
    if peers is None:
        peers = []
    if not isinstance(peers, list) or any(not isinstance(x, str) for x in peers):
        raise SystemExit(3)
    agents = cfg.get("a2a_agents", {})
    if not isinstance(agents, dict) or len(agents) > 32:
        raise SystemExit(3)
    outgoing = []
    for name, entry in agents.items():
        if not isinstance(name, str) or not isinstance(entry, dict):
            raise SystemExit(3)
        url, auth = entry.get("url", ""), entry.get("auth") or {}
        if not isinstance(url, str) or not isinstance(auth, dict):
            raise SystemExit(3)
        token = auth.get("token", "")
        if not isinstance(token, str):
            raise SystemExit(3)
        if url:
            outgoing.append({"name": name, "tokenPresent": auth.get("type") == "bearer" and bool(token.strip())})
    return {
        "peerTokens": env.get("A2A_PEER_TOKENS", ""),
        "peerTokensPresent": "A2A_PEER_TOKENS" in env,
        "trustedPeersEnv": env.get("A2A_TRUSTED_PEERS", ""),
        "trustedPeersEnvPresent": "A2A_TRUSTED_PEERS" in env,
        "allowAllEnv": env.get("A2A_ALLOW_ALL_USERS", ""),
        "allowAllEnvPresent": "A2A_ALLOW_ALL_USERS" in env,
        "configTrusted": peers,
        "outgoingPeers": outgoing,
    }

action = sys.argv[1] if len(sys.argv) == 2 else ""
request = json.load(sys.stdin)
if not isinstance(request, dict):
    raise SystemExit(4)
if action == "read":
    pass
elif action == "token-set":
    value = request.get("value")
    if not isinstance(value, str) or len(value.encode("utf-8")) > 8192:
        raise SystemExit(4)
    save_env_value("A2A_PEER_TOKENS", value)
elif action == "trust-set":
    peers = request.get("trustedPeers")
    if not isinstance(peers, list) or len(peers) > 32 or any(not isinstance(x, str) for x in peers):
        raise SystemExit(4)
    cfg = load_config() or {}
    if not isinstance(cfg, dict):
        raise SystemExit(3)
    section = cfg.get("a2a", {})
    if section is None:
        section = {}
    if not isinstance(section, dict):
        raise SystemExit(3)
    section["trusted_peers"] = peers
    cfg["a2a"] = section
    save_config(cfg)
else:
    raise SystemExit(4)
print(json.dumps(read_policy(), separators=(",", ":")))
