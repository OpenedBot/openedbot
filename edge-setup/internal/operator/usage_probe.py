"""Bounded, read-only account-usage probe run by hermes-operator.

This source is embedded in the edge-setup binary and is sent on stdin to the
managed Hermes venv interpreter.  It intentionally accepts only the
provider names the Go caller passes from a fixed allowlist.  In particular it
does not receive a credential, a URL, a path, or an arbitrary command.
"""

import concurrent.futures
import dataclasses
import datetime
import json
import math
import os
import sys

from agent.account_usage import fetch_account_usage


ALLOWED = {"anthropic", "openai-codex", "openrouter", "xai-oauth"}
MAX_OUTPUT = 256 * 1024


def as_json(value, depth=0):
    """Turn upstream dataclasses/Pydantic objects into JSON without secrets."""
    if depth > 8:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:200]
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if dataclasses.is_dataclass(value):
        return as_json(dataclasses.asdict(value), depth + 1)
    for name in ("model_dump", "dict", "to_dict"):
        method = getattr(value, name, None)
        if callable(method):
            try:
                return as_json(method(), depth + 1)
            except Exception:
                pass
    if isinstance(value, dict):
        out = {}
        for key, item in list(value.items())[:64]:
            text = str(key)
            # A usage response must never echo an OAuth token, API key, cookie,
            # or authorization header even if a future upstream fetcher does.
            if any(word in text.lower() for word in ("token", "secret", "key", "cookie", "authorization", "credential")):
                continue
            out[text[:64]] = as_json(item, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [as_json(item, depth + 1) for item in value[:32]]
    return None


def runtime_credential(provider):
    """The credential the gateway serves with right now, or None.

    ``fetch_account_usage`` alone resolves the singleton store first, then the
    FIRST pool entry whose cooldown is not recorded: measured 2026-09-05: two
    exhausted logins of an old account sat ahead of the fresh one, so the card
    showed the old account at 100 % while every run passed on the new one.
    ``peek()`` is the pool's own non-mutating choice: current entry, else the
    first one not exhausted.  Only Codex rotates OAuth logins this way.
    """
    if provider != "openai-codex":
        return None
    try:
        from agent.credential_pool import load_pool

        pool = load_pool(provider)
        entry = pool.peek() if pool is not None else None
        if entry is None:
            return None
        key = str(getattr(entry, "runtime_api_key", "") or "").strip()
        base_url = getattr(entry, "runtime_base_url", None) or None
        return (key, base_url) if key else None
    except Exception:
        return None


def anthropic_serves_api_key():
    """True when the Anthropic credential the gateway serves with is an API key.

    The key lives in the credential pool (``auth.json`` ``credential_pool``),
    where ``fetch_account_usage`` alone never looks, and upstream only reads
    account limits for OAuth-backed Claude accounts anyway.  An API key is
    billed per use: it has no plan quota, and that is not a probe failure.
    """
    try:
        from agent.anthropic_credentials import _is_oauth_token
        from agent.credential_pool import load_pool

        pool = load_pool("anthropic")
        entry = pool.peek() if pool is not None else None
        if entry is None:
            return False
        key = str(getattr(entry, "runtime_api_key", "") or "").strip()
        return bool(key) and not _is_oauth_token(key)
    except Exception:
        return False


# Hermes reads no account usage for xAI.  Its ``xai-oauth`` login is the Grok
# CLI's own OAuth client (``XAI_OAUTH_CLIENT_ID`` b1a00492-..., scope
# ``grok-cli:access``), so the token opens the endpoint the Grok CLI reads its
# subscription quota from (same call as t3code ``provider-grok/usageLimits.ts``).
XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
XAI_BILLING_MAX_BODY = 64 * 1024


def xai_oauth_token():
    """The xAI OAuth access token the gateway serves with, never refreshed here.

    Refreshing rotates the grant the gateway owns: this read-only probe only
    reads.  An expired token yields an HTTP 401, reported as unavailable, and
    the next run refreshes it.
    """
    try:
        from agent.credential_pool import load_pool

        pool = load_pool("xai-oauth")
        entry = pool.peek() if pool is not None else None
        key = str(getattr(entry, "runtime_api_key", "") or "").strip() if entry is not None else ""
        if key:
            return key
    except Exception:
        pass
    try:
        from hermes_cli.auth_xai import resolve_xai_oauth_runtime_credentials

        credentials = resolve_xai_oauth_runtime_credentials(refresh_if_expiring=False)
        return str(credentials.get("api_key") or "").strip() or None
    except Exception:
        return None


def _iso_instant(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(datetime.timezone.utc)


def xai_billing_usage(body):
    """Grok's billing document as one usage window, or None when unreadable.

    ``{"config": {"creditUsagePercent": 12.5, "currentPeriod": {"type":
    "USAGE_PERIOD_TYPE_WEEKLY", "start": "...", "end": "..."}}}``.  Grok omits
    a zero percentage but keeps the period: a complete weekly or monthly
    period without a percentage reads 0 %, anything else is not a reading.
    """
    config = body.get("config") if isinstance(body, dict) else None
    if not isinstance(config, dict):
        return None
    period = config.get("currentPeriod")
    period = period if isinstance(period, dict) else {}
    kind = str(period.get("type") or "").replace("USAGE_PERIOD_TYPE_", "", 1)
    label = {"WEEKLY": "Weekly", "MONTHLY": "Monthly"}.get(kind, "Subscription")
    start, end = _iso_instant(period.get("start")), _iso_instant(period.get("end"))
    used = config.get("creditUsagePercent")
    if used is None and kind in ("WEEKLY", "MONTHLY") and start is not None and end is not None and start < end:
        used = 0
    if isinstance(used, bool) or not isinstance(used, (int, float)) or not math.isfinite(used):
        return None
    window = {"label": label, "used_percent": max(0.0, min(100.0, float(used)))}
    if end is not None:
        window["reset_at"] = end.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {"windows": [window]}


def fetch_xai_oauth_usage():
    token = xai_oauth_token()
    if not token:
        return None
    import httpx

    with httpx.Client(timeout=10.0, follow_redirects=False) as client:
        response = client.get(
            XAI_BILLING_URL,
            headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
        )
    # A 403 ``WKE=privacy-mode:`` (legacy privacy setting) or a 401 (expired
    # token) is a failure like any other: its text is never relayed.
    response.raise_for_status()
    if len(response.content) > XAI_BILLING_MAX_BODY:
        return None
    return xai_billing_usage(response.json())


def probe(provider):
    if provider == "xai-oauth":
        try:
            usage = fetch_xai_oauth_usage()
        except Exception:
            usage = None
        if usage is None:
            return {"provider": provider, "unavailableReason": "account usage is unavailable"}
        return {"provider": provider, "usage": usage}
    if provider == "anthropic" and anthropic_serves_api_key():
        return {"provider": provider, "credential": "api_key"}
    try:
        credential = runtime_credential(provider)
        usage = (
            fetch_account_usage(provider, api_key=credential[0], base_url=credential[1])
            if credential
            else fetch_account_usage(provider)
        )
        return {"provider": provider, "usage": as_json(usage)}
    except Exception:
        # Upstream exception text can contain transport diagnostics.  It is not
        # part of this public contract and is deliberately not returned.
        return {"provider": provider, "unavailableReason": "account usage is unavailable"}


def main():
    providers = [name for name in sys.argv[1:] if name in ALLOWED]
    # Keep one short-lived concurrent request per supported provider.  Do not
    # wait for a stuck third-party request once the budget expires: os._exit
    # below terminates those worker threads after the bounded JSON is flushed.
    results = {name: {"provider": name, "unavailableReason": "account usage timed out"} for name in providers}
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=len(providers) or 1)
    futures = {pool.submit(probe, name): name for name in providers}
    try:
        for future in concurrent.futures.as_completed(futures, timeout=22):
            name = futures[future]
            try:
                results[name] = future.result()
            except Exception:
                results[name] = {"provider": name, "unavailableReason": "account usage is unavailable"}
    except concurrent.futures.TimeoutError:
        pass
    document = {
        "fetchedAt": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "providers": [results[name] for name in providers],
    }
    encoded = json.dumps(document, separators=(",", ":"), ensure_ascii=True)
    if len(encoded.encode("utf-8")) > MAX_OUTPUT:
        document["providers"] = [
            {"provider": name, "unavailableReason": "account usage response was too large"}
            for name in providers
        ]
        encoded = json.dumps(document, separators=(",", ":"), ensure_ascii=True)
    sys.stdout.write(encoded)
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
