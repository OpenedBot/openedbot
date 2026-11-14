"""Fixed profile-only lab browser configuration. Never imports Hermes/plugins."""
import json
import http.client
import os
import re
import stat
import shutil
import signal
import select
import time
import subprocess
import sys
import tempfile

ROOT = "/srv/hermes/data"
KEYS = ("allow_private_urls", "cloud_provider", "use_gateway", "engine", "headed", "cdp_url", "user_data_dir", "use_real_profile", "chromium_args", "executable_path")


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_size <= 1048576, "unsafe profile file")
        return handle.read(1048577)


def profile_path(profile, allow_missing=False):
    require(isinstance(profile, str) and re.fullmatch(r"e2e-[a-z0-9][a-z0-9-]{0,58}", profile), "invalid E2E profile")
    for path in (ROOT, os.path.join(ROOT, "profiles"), os.path.join(ROOT, "profiles", profile)):
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            if allow_missing and path == os.path.join(ROOT, "profiles", profile):
                return None
            raise
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid(), "unsafe profile directory")
    return os.path.join(ROOT, "profiles", profile, "config.yaml")


def load(path):
    raw = read(path).decode("utf-8")
    try:
        import yaml
        value = yaml.safe_load(raw)
    except ImportError:
        from ruamel.yaml import YAML
        value = YAML(typ="safe", pure=True).load(raw)
    require(isinstance(value, dict), "profile config is not a mapping")
    require("browser" not in value or isinstance(value["browser"], dict), "profile browser section is not a mapping")
    return value


def write(path, config):
    try:
        import yaml
        data = yaml.safe_dump(config, sort_keys=False, allow_unicode=True)
    except ImportError:
        import io
        from ruamel.yaml import YAML
        output = io.StringIO()
        YAML(typ="safe", pure=True).dump(config, output)
        data = output.getvalue()
    descriptor, temporary = tempfile.mkstemp(prefix=".lab-browser-", dir=os.path.dirname(path))
    try:
        with os.fdopen(descriptor, "w") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def snapshot(config):
    browser = config.get("browser", {})
    return {"browserPresent": "browser" in config, "fields": {key: browser[key] for key in KEYS if key in browser}}


def equal(left, right):
    # Python bool == int would otherwise accept a changed boolean as exact.
    return json.dumps(left, sort_keys=True, separators=(",", ":")) == json.dumps(right, sort_keys=True, separators=(",", ":"))


PROBE_TIMEOUT_SECONDS = 15
PROBE_STDERR_BYTES = 8192
# This isolated worker only reads the tiny CDP version endpoint.
http.client._MAXLINE = 4096
http.client._MAXHEADERS = 16


class ReadinessRefused(ValueError):
    pass


def devtools_port(home, launched_ns):
    try:
        descriptor = os.open(os.path.join(home, "DevToolsActivePort"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise ReadinessRefused("unsafe DevToolsActivePort file")
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_size > 256 or info.st_mtime_ns < launched_ns:
            raise ReadinessRefused("unsafe or stale DevToolsActivePort file")
        data = handle.read(257)
    try:
        lines = data.decode("ascii").splitlines()
    except UnicodeDecodeError:
        raise ReadinessRefused("malformed DevToolsActivePort content")
    if len(lines) != 2 or not re.fullmatch(r"[1-9][0-9]{3,4}", lines[0]) or not re.fullmatch(r"/devtools/browser/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", lines[1]):
        raise ReadinessRefused("malformed DevToolsActivePort content")
    port = int(lines[0])
    if not 1024 <= port <= 65535:
        raise ReadinessRefused("invalid DevToolsActivePort port")
    return port, lines[1]


def cdp_ready(port, path, version):
    # http.client uses this literal loopback address directly: no proxy,
    # redirect handling, provider auth, cookies, or caller-supplied URL.
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.3)
    try:
        connection.request("GET", "/json/version", headers={"Connection": "close"})
        response = connection.getresponse()
        if response.status != 200:
            raise ReadinessRefused("CDP version endpoint returned a non-200 response")
        data = response.read(4097)
        if len(data) > 4096:
            raise ReadinessRefused("CDP version response exceeded its bound")
        try:
            value = json.loads(data)
        except ValueError:
            raise ReadinessRefused("CDP version response is malformed")
        if not isinstance(value, dict) or value.get("Browser") not in ("Chrome/" + version, "HeadlessChrome/" + version):
            raise ReadinessRefused("CDP browser version does not match the pinned browser")
        if value.get("webSocketDebuggerUrl") != "ws://127.0.0.1:%d%s" % (port, path):
            raise ReadinessRefused("CDP websocket identity does not match the owned port and path")
        return True
    except (OSError, http.client.HTTPException):
        return False  # The port file can precede the listener becoming ready.
    finally:
        connection.close()



def probe(executable, pinned_version):
    require(isinstance(executable, str) and executable.startswith("/usr/local/lib/hermes-chromium/") and os.path.normpath(executable) == executable and os.path.basename(executable) in ("chrome", "chromium"), "unmanaged browser executable")
    version = pinned_version.split("+", 1)[-1] if isinstance(pinned_version, str) else ""
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}", version), "invalid pinned browser version")
    diagnostic = {"cdpReady": False, "readinessError": "", "outcome": "launch_failed", "exitCode": None, "signal": None, "timedOut": False, "stderrTail": "", "truncated": False}
    with tempfile.TemporaryDirectory(prefix=".lab-browser-probe-", dir=ROOT) as home:
        command = [executable, "--headless=new", "--remote-debugging-port=0", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--no-pings", "--user-data-dir=" + home, "about:blank"]
        # This fixed about:blank probe sees no application credentials, user
        # profile, provider keys, proxy variables or inherited loader settings.
        os.mkdir(os.path.join(home, "config"))
        os.mkdir(os.path.join(home, "cache"))
        env = {"PATH": "/usr/bin:/bin", "HOME": home, "XDG_CONFIG_HOME": os.path.join(home, "config"), "XDG_CACHE_HOME": os.path.join(home, "cache"), "TMPDIR": home, "LANG": "C", "LC_ALL": "C", "USER": "hermes", "LOGNAME": "hermes"}
        launched_ns = time.time_ns()
        try:
            child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, bufsize=0, env=env, start_new_session=True)
        except OSError:
            return {"installed": False, "removed": False, "probeDiagnostic": diagnostic}
        tail = bytearray()
        seen = 0
        descriptor = child.stderr.fileno()
        os.set_blocking(descriptor, False)

        def drain():
            nonlocal seen
            try:
                chunk = os.read(descriptor, 4096)
            except BlockingIOError:
                return False
            seen += len(chunk)
            tail.extend(chunk)
            del tail[:-PROBE_STDERR_BYTES]
            return bool(chunk)

        deadline = time.monotonic() + PROBE_TIMEOUT_SECONDS

        def timed_out(_signal, _frame):
            raise TimeoutError("fixed CDP readiness deadline")

        previous_alarm = signal.signal(signal.SIGALRM, timed_out)
        signal.setitimer(signal.ITIMER_REAL, PROBE_TIMEOUT_SECONDS)
        try:
            while child.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("fixed CDP readiness deadline")
                if select.select([descriptor], [], [], min(0.05, remaining))[0]:
                    if not drain():
                        time.sleep(min(0.01, remaining))
                port = devtools_port(home, launched_ns)
                if port is not None and cdp_ready(*port, version):
                    diagnostic["cdpReady"] = True
                    break
            if not diagnostic["cdpReady"]:
                diagnostic["readinessError"] = "browser exited before CDP readiness"
        except TimeoutError:
            diagnostic["timedOut"] = True
            diagnostic["readinessError"] = "CDP readiness deadline exceeded"
        except ReadinessRefused as error:
            diagnostic["readinessError"] = str(error)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_alarm)
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=3)
            # A descendant which escaped its group cannot keep this pipe or
            # reader alive: post-exit drainage is nonblocking and bounded.
            for _ in range(64):
                if not drain():
                    break
            child.stderr.close()
        code = child.returncode
        diagnostic.update(outcome="timeout" if diagnostic["timedOut"] else "succeeded" if diagnostic["cdpReady"] and code in (0, -signal.SIGKILL) else "failed",
                          exitCode=code if code >= 0 else None, signal=-code if code < 0 else None,
                          stderrTail="".join(chr(value) if 32 <= value < 127 or value in (9, 10, 13) else "?" for value in tail),
                          truncated=seen > PROBE_STDERR_BYTES)
    return {"installed": False, "removed": False, "probeDiagnostic": diagnostic}


def sidecar_state(request, create=False):
    nonce = request.get("nonce")
    require(isinstance(nonce, str) and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", nonce), "invalid sidecar nonce")
    require(isinstance(request.get("runtimeId"), str), "missing sidecar runtime")
    require(isinstance(request.get("profile"), str) and re.fullmatch(r"e2e-[a-z0-9][a-z0-9-]{0,58}", request["profile"]), "invalid sidecar profile")
    parent = os.path.join(ROOT, "lab-browser-fixtures")
    path = os.path.join(parent, nonce)
    expected = {key: request[key] for key in ("nonce", "profile", "runtimeId")}
    for directory in (ROOT, parent, path):
        if create and directory != ROOT:
            try:
                os.mkdir(directory, 0o700)
            except FileExistsError:
                pass
        try:
            info = os.lstat(directory)
        except FileNotFoundError:
            if not create:
                return path, expected
            raise
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid(), "unsafe sidecar state directory")
    sidecar_marker(path, expected, create)
    return path, expected


def sidecar_marker(path, expected, create):
    marker = os.path.join(path, ".owner.json")
    if os.path.lexists(marker):
        require(equal(json.loads(read(marker)), expected), "sidecar state changed ownership")
        return
    require(set(os.listdir(path)) <= {".owner.json.tmp"}, "sidecar ownership marker is missing or foreign payload exists")
    temporary = marker + ".tmp"
    if os.path.lexists(temporary):
        # A lost rename may leave a complete same-target marker. A foreign
        # or partially written marker is ambiguous and must remain untouched.
        require(equal(json.loads(read(temporary)), expected), "temporary sidecar marker changed ownership")
        if create:
            os.unlink(temporary)
    if create:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump(expected, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, marker)


RUNTIME_ROOT = "/run/user"


def sidecar_short_tmp(request, expected, create=False):
    if request.get("shortTmpDir") is not True:
        return None  # An older receipt never owned a runtime-directory tree.
    for path in (os.path.dirname(RUNTIME_ROOT), RUNTIME_ROOT):
        info = os.lstat(path)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, "unsafe runtime directory parent")
    runtime = os.path.join(RUNTIME_ROOT, str(os.geteuid()))
    info = os.lstat(runtime)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077, "unsafe service runtime directory")
    path = os.path.join(runtime, "ob-" + expected["nonce"].replace("-", ""))
    require(len((path + "/.org.chromium.Chromium.XXXXXX/SingletonSocket").encode()) <= 107, "temporary browser socket path is too long")
    if create:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
    if not os.path.lexists(path):
        return path
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077, "unsafe owned short browser directory")
    sidecar_marker(path, expected, create)
    return path


def sidecar_remove_tree(path):
    if path is None or not os.path.lexists(path):
        return
    # Keep each ownership marker until its payload is fully gone. A crash
    # between the final unlink/rmdir leaves only an empty owned directory.
    for name in os.listdir(path):
        if name == ".owner.json":
            continue
        child = os.path.join(path, name)
        if os.path.isdir(child) and not os.path.islink(child):
            shutil.rmtree(child)
        else:
            os.unlink(child)
    marker = os.path.join(path, ".owner.json")
    if os.path.lexists(marker):
        os.unlink(marker)
    os.rmdir(path)


def sidecar_control(request):
    action = request["action"]
    state, identity = sidecar_state(request, action == "sidecar-prepare")
    short = sidecar_short_tmp(request, identity, action == "sidecar-prepare")
    if action == "sidecar-ownership":
        if request.get("allowRemoved") is not True:
            require(os.path.isfile(os.path.join(state, ".owner.json")), "browser state ownership is not established")
            require(short is None or os.path.isfile(os.path.join(short, ".owner.json")), "short browser ownership is not established")
        return {"installed": False, "removed": False}
    if action == "sidecar-prepare":
        for suffix in ("home", "home/config", "home/cache", "home/tmp", "home/userdata"):
            path = os.path.join(state, suffix)
            try:
                os.mkdir(path, 0o700)
            except FileExistsError:
                pass
            info = os.lstat(path)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid(), "sidecar directory changed ownership")
        if request.get("resetPort") is True:
            port = os.path.join(state, "home", "userdata", "DevToolsActivePort")
            if os.path.lexists(port):
                read(port)
                os.unlink(port)
        return {"installed": False, "removed": False}
    if action == "sidecar-cleanup":
        require(request.get("stopped") is True, "sidecar stop was not independently proven")
        # Both markers were verified above before either tree is modified.
        sidecar_remove_tree(short)
        sidecar_remove_tree(state)
        return {"installed": False, "removed": True}
    require(action == "sidecar-observe" and os.path.isfile(os.path.join(state, ".owner.json")), "sidecar state is not prepared")
    version = request.get("version", "").split("+", 1)[-1]
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}", version), "invalid pinned sidecar version")
    launched_ns = request.get("launchedNs")
    require(type(launched_ns) is int and launched_ns > 0, "missing sidecar launch fence")
    diagnostic = {"outcome": "failed", "cdpReady": False, "readinessError": "", "exitCode": None, "signal": None, "timedOut": False, "stderrTail": "", "truncated": False}
    url = ""
    def timed_out(_signal, _frame):
        raise TimeoutError("sidecar CDP deadline")
    previous_alarm = signal.signal(signal.SIGALRM, timed_out)
    signal.setitimer(signal.ITIMER_REAL, PROBE_TIMEOUT_SECONDS)
    deadline = time.monotonic() + PROBE_TIMEOUT_SECONDS
    try:
        while time.monotonic() < deadline:
            port = devtools_port(os.path.join(state, "home", "userdata"), launched_ns)
            if port is not None and cdp_ready(*port, version):
                diagnostic["cdpReady"] = True
                diagnostic["outcome"] = "succeeded"
                url = "ws://127.0.0.1:%d%s" % port
                break
            time.sleep(0.05)
        if not diagnostic["cdpReady"]:
            raise TimeoutError("sidecar CDP deadline")
    except TimeoutError:
        diagnostic["outcome"], diagnostic["timedOut"], diagnostic["readinessError"] = "timeout", True, "sidecar CDP readiness deadline exceeded"
    except ReadinessRefused as error:
        diagnostic["readinessError"] = str(error)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_alarm)
    return {"installed": False, "removed": False, "probeDiagnostic": diagnostic, "cdpUrl": url}


def control(request):
    action = request.get("action")
    if action in ("sidecar-prepare", "sidecar-observe", "sidecar-cleanup", "sidecar-ownership"):
        return sidecar_control(request)
    if action == "probe":
        return probe(request.get("executable"), request.get("version"))
    require(action in ("prepare", "setup", "receipts", "remove", "verify-original"), "invalid browser fixture action")
    path = profile_path(request.get("profile"), action in ("receipts", "remove", "verify-original"))
    if path is None:
        return {"installed": False, "removed": action != "receipts", "profileAbsent": True}
    directory = os.lstat(os.path.dirname(path))
    identity = {"device": directory.st_dev, "inode": directory.st_ino}
    if action != "prepare":
        bound = request.get("before", {}).get("directoryIdentity")
        require(bound is None or equal(bound, identity), "profile directory was replaced; restoration refused")
    config = load(path)
    if action == "prepare":
        # A fresh profile must not carry a hidden remote-browser override.
        env_path = os.path.join(os.path.dirname(path), ".env")
        if os.path.lexists(env_path):
            text = read(env_path).decode("utf-8")
            for line in text.splitlines():
                require(not re.match(r"\s*(?:export\s+)?(?:BROWSER_CDP_URL|BU_CDP_URL|BU_CDP_WS)\s*=", line), "profile has a CDP environment override")
        before = snapshot(config)
        before["directoryIdentity"] = identity
        return {"before": before}
    before, owned = request["before"], request["owned"]
    current = snapshot(config)
    original = equal(current["fields"], before["fields"])
    installed = equal(current["fields"], owned)
    require(original or installed, "owned browser fields changed; restoration refused")
    if action == "verify-original":
        require(original, "original browser fields changed")
        return {"installed": False, "removed": True}
    if action == "receipts":
        return {"installed": installed, "removed": False}
    if action == "setup":
        if not installed:
            browser = config.setdefault("browser", {})
            browser.update(owned)
            write(path, config)
        require(equal(snapshot(load(path))["fields"], owned), "browser patch readback failed")
        return {"installed": True, "removed": False}
    if installed:
        browser = config["browser"]
        for key in KEYS:
            browser.pop(key, None)
        browser.update(before["fields"])
        if not before["browserPresent"] and not browser:
            config.pop("browser", None)
        write(path, config)
    require(equal(snapshot(load(path))["fields"], before["fields"]), "browser restoration readback failed")
    return {"installed": False, "removed": True}


if __name__ == "__main__":
    try:
        data = sys.stdin.buffer.read(32769)
        require(len(data) <= 32768, "fixture request too large")
        print(json.dumps(control(json.loads(data))))
    except Exception:
        # Provider credentials or original profile values never cross stderr.
        print("owned browser fixture refused; profile retained for reconciliation", file=sys.stderr)
        sys.exit(1)
