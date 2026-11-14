"""Minimal Expo Push Notification client (stdlib only).

Docs: https://docs.expo.dev/push-notifications/sending-notifications/
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
CHUNK_SIZE = 100  # Expo accepts at most 100 messages per request.

# (url, json_body, headers) -> parsed JSON response
Transport = Callable[[str, list[dict[str, Any]], dict[str, str]], dict[str, Any]]


def _default_transport(url: str, body: list[dict[str, Any]], headers: dict[str, str]) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Expo push API returned HTTP {exc.code}: {detail[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach Expo push API: {exc.reason}") from exc
    except (OSError, ValueError) as exc:  # read timeouts, resets, malformed JSON
        raise RuntimeError(f"Bad response from Expo push API: {exc}") from exc


def send_push_messages(
    messages: list[dict[str, Any]],
    transport: Transport | None = None,
) -> dict[str, Any]:
    """Send messages to Expo in chunks and summarise the push tickets.

    Returns {"sent": n_ok, "failed": n_err, "tickets": [...], "invalid_tokens": [...], "errors": [...]}.
    `invalid_tokens` lists tokens Expo reported as DeviceNotRegistered so callers can drop them.
    A chunk that fails as a whole is counted as failed and listed in `errors`; the other chunks still go out.
    Raises RuntimeError only when every chunk failed.
    """
    send = transport or _default_transport
    # No Accept-Encoding: urllib does not decompress gzip, so a compressed reply would be unreadable.
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    access_token = os.environ.get("EXPO_ACCESS_TOKEN")
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"

    tickets: list[dict[str, Any]] = []
    invalid_tokens: list[str] = []
    errors: list[str] = []
    sent = failed = 0
    chunks = [messages[i : i + CHUNK_SIZE] for i in range(0, len(messages), CHUNK_SIZE)]

    for chunk in chunks:
        try:
            resp = send(EXPO_PUSH_URL, chunk, headers)
            if not isinstance(resp, dict):
                raise RuntimeError("Expo push API returned an unexpected response")
            if resp.get("errors"):
                raise RuntimeError(f"Expo push request rejected: {resp['errors']}")
        except RuntimeError as exc:
            failed += len(chunk)
            errors.append(str(exc))
            continue
        data = resp.get("data") or []
        for msg, ticket in zip(chunk, data):
            tickets.append({"to": msg["to"], **ticket})
            if ticket.get("status") == "ok":
                sent += 1
            else:
                failed += 1
                if (ticket.get("details") or {}).get("error") == "DeviceNotRegistered":
                    invalid_tokens.append(msg["to"])
        failed += max(0, len(chunk) - len(data))  # tickets missing from the reply

    if chunks and len(errors) == len(chunks):
        raise RuntimeError(errors[0])
    return {"sent": sent, "failed": failed, "tickets": tickets, "invalid_tokens": invalid_tokens, "errors": errors}
