"""HTTP server and JSON API for DabbaTrack Tiffin Service PWA."""

from __future__ import annotations

import functools
import json
import logging
import mimetypes
import os
import re
import signal
import sqlite3
import threading
import time
from collections import deque
from datetime import date, datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import db
import push
import qr

STATIC_DIR = Path(__file__).parent / "static"

log = logging.getLogger("dabbatrack")

MAX_BODY_BYTES = 64 * 1024  # largest JSON body accepted (menus, notes and forms are far smaller)
REQUEST_TIMEOUT_S = 30  # drop connections that stall mid-request so they can't pin a thread


def configure_logging() -> None:
    """One log line per event: timestamp, level, message. LOG_LEVEL=DEBUG|INFO|WARNING (default INFO)."""
    level = os.environ.get("LOG_LEVEL", "INFO").strip().upper() or "INFO"
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


class BadRequest(Exception):
    """Client error raised while reading the request; becomes a JSON error response."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


_MISSING = object()


def _field(body: dict[str, Any], key: str, default: Any = _MISSING) -> Any:
    if key in body and body[key] is not None:
        return body[key]
    if default is _MISSING:
        raise KeyError(key)
    return default


def int_field(body: dict[str, Any], key: str, default: Any = _MISSING) -> int:
    """Whole number: JSON int, integral float (5.0) or digit string ("5"). Rejects booleans and 5.7."""
    value = _field(body, key, default)
    if isinstance(value, bool):
        raise ValueError(f"{key} must be a whole number")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"\s*-?\d{1,9}\s*", value):
        return int(value)
    raise ValueError(f"{key} must be a whole number")


def num_field(body: dict[str, Any], key: str, default: Any = _MISSING) -> float:
    """Finite number: JSON number or numeric string ("1200.50"). Rejects booleans, NaN and Infinity."""
    value = _field(body, key, default)
    if isinstance(value, bool):
        raise ValueError(f"{key} must be a number")
    if isinstance(value, str) and re.fullmatch(r"\s*-?\d{1,9}(\.\d{1,2})?\s*", value):
        value = float(value)
    if isinstance(value, (int, float)) and value == value and value not in (float("inf"), float("-inf")):
        return float(value)
    raise ValueError(f"{key} must be a number")


_TRUE, _FALSE = {"true", "1", "yes", "on"}, {"false", "0", "no", "off"}


def bool_field(body: dict[str, Any], key: str, default: Any = _MISSING) -> bool:
    """True/false: JSON boolean, 0/1, or "true"/"false"/"yes"/"no". (Plain bool("false") would be True.)"""
    value = _field(body, key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.strip().lower() in _TRUE | _FALSE:
        return value.strip().lower() in _TRUE
    raise ValueError(f"{key} must be true or false")


def str_field(body: dict[str, Any], key: str, default: Any = _MISSING) -> str:
    """Text. Numbers are accepted for digit fields like phone and PIN; objects, lists and booleans aren't."""
    value = _field(body, key, default)
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError(f"{key} must be text")
    return str(value)


def _reject_json_constant(name: str) -> Any:
    raise ValueError(f"{name} is not allowed in JSON")


def _friendly_integrity_error(exc: sqlite3.IntegrityError) -> str:
    text = str(exc)
    if "customers.phone" in text:
        return "A customer with this phone number already exists"
    if "UNIQUE" in text:
        return "This already exists"
    return "This change conflicts with existing data"


def _guarded(method):
    """Wrap a do_* handler so no exception ever drops the connection without a reply."""

    @functools.wraps(method)
    def wrapper(self: "TiffinHandler") -> None:
        self._response_started = False
        try:
            method(self)
        except BadRequest as exc:
            self.close_connection = True
            self._send_error_json(exc.message, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            log.info("Client disconnected during %s %s", self.command, urlparse(self.path).path)
        except sqlite3.OperationalError as exc:
            if "locked" in str(exc) or "busy" in str(exc):
                log.warning("Database busy on %s %s: %s", self.command, urlparse(self.path).path, exc)
                self._send_error_json("Server is busy, please try again", HTTPStatus.SERVICE_UNAVAILABLE, {"Retry-After": "2"})
            else:
                log.exception("Database error on %s %s", self.command, urlparse(self.path).path)
                self._send_error_json("Something went wrong on the server. Please try again.", HTTPStatus.INTERNAL_SERVER_ERROR)
        except Exception:
            log.exception("Unhandled error on %s %s", self.command, urlparse(self.path).path)
            self._send_error_json("Something went wrong on the server. Please try again.", HTTPStatus.INTERNAL_SERVER_ERROR)

    return wrapper

# Tests (or alternative deployments) can swap in a fake transport for Expo push calls.
PUSH_TRANSPORT: push.Transport | None = None


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


# DEMO_MODE=1 seeds demo customers and exposes their PINs at /api/demo. Never enable it for real users.
DEMO_MODE = _env_flag("DEMO_MODE")
# TRUST_PROXY=1 uses the first X-Forwarded-For address as the client IP (only behind your own reverse proxy).
TRUST_PROXY = _env_flag("TRUST_PROXY")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": os.environ.get("CORS_ALLOW_ORIGIN", "*"),
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    "Access-Control-Max-Age": "86400",
}

# Sent on every response.
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
}
# Sent with the PWA's HTML. 'unsafe-inline' is needed for the existing inline onclick handlers;
# everything else is locked to this origin, and the page can't be framed (clickjacking).
HTML_SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; "
        "manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    ),
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
}

# Routes that need no login. Everything else under /api/ requires "Authorization: Bearer <token>".
PUBLIC_ROUTES = {
    ("GET", "/api/health"),
    ("GET", "/api/demo"),
    ("POST", "/api/customer/login"),
    ("POST", "/api/provider/login"),
}
# POST routes a customer may call for their own customer_id (the provider may call them for anyone).
CUSTOMER_POST_ROUTES = {
    "/api/customers/push-token",
    "/api/meals/respond",
    "/api/meals/pause",
    "/api/meals/resume",
    "/api/meals/scan-qr",
}
ANY_ROLE_POST_ROUTES = {"/api/auth/logout"}
_CUSTOMER_PATH_RE = re.compile(r"^/api/customers/(\d+)/([a-z-]+)$")


class Forbidden(Exception):
    """Raised when a signed-in user tries to act on someone else's data."""


class LoginLimiter:
    """In-memory brute-force guard for PIN logins (per server process).

    A key is locked for `lockout_s` once it collects `limit` failures within `window_s`.
    """

    def __init__(self, window_s: int = 900, lockout_s: int = 900) -> None:
        self.window_s = window_s
        self.lockout_s = lockout_s
        self._lock = threading.Lock()
        self._fails: dict[str, deque[float]] = {}
        self._locked_until: dict[str, float] = {}

    def reset(self) -> None:
        with self._lock:
            self._fails.clear()
            self._locked_until.clear()

    def retry_after(self, keys: list[str]) -> int:
        """Seconds until all keys are unlocked (0 = allowed)."""
        now = time.monotonic()
        with self._lock:
            wait = max((self._locked_until.get(k, 0) - now for k in keys), default=0)
        return max(0, int(wait + 0.999))

    def record_failure(self, limits: dict[str, int]) -> None:
        now = time.monotonic()
        with self._lock:
            for key, limit in limits.items():
                q = self._fails.setdefault(key, deque())
                q.append(now)
                while q and q[0] < now - self.window_s:
                    q.popleft()
                if len(q) >= limit:
                    self._locked_until[key] = now + self.lockout_s
                    q.clear()

    def record_success(self, keys: list[str]) -> None:
        with self._lock:
            for key in keys:
                self._fails.pop(key, None)
                self._locked_until.pop(key, None)


LOGIN_LIMITER = LoginLimiter()
ACCOUNT_FAIL_LIMIT = 5  # per phone number, or per IP for the provider PIN
IP_FAIL_LIMIT = 20  # any login, per client IP


def _set_broadcast(conn: sqlite3.Connection, meal_type: str) -> str:
    stamp = f"{meal_type}|{datetime.now().isoformat(timespec='seconds')}"
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('popup_broadcast', ?)",
        (stamp,),
    )
    return stamp


def send_meal_prompt(meal_type: str, meal_date: str | None = None, dry_run: bool = False) -> dict[str, Any]:
    """Build and send Expo meal-confirmation pushes. Raises ValueError for invalid states.

    The DB connection is not held open during the network call to Expo.
    """
    with db.get_connection() as conn:
        messages = db.build_meal_prompt_messages(conn, meal_type=meal_type, meal_date=meal_date)
        stamp = _set_broadcast(conn, meal_type) if not dry_run else ""

    result: dict[str, Any] = {
        "meal_type": meal_type,
        "meal_date": meal_date or date.today().isoformat(),
        "recipients": len(messages),
        "broadcast": stamp,
        "dry_run": dry_run,
    }
    if dry_run or not messages:
        result.update({"sent": 0, "failed": 0, "tickets": [], "invalid_tokens": []})
        if dry_run:
            result["messages"] = messages
        return result

    summary = push.send_push_messages(messages, transport=PUSH_TRANSPORT)
    if summary["invalid_tokens"]:
        with db.get_connection() as conn:
            db.clear_push_tokens(conn, summary["invalid_tokens"])
    result.update(summary)
    return result


def due_auto_prompts(
    now: datetime,
    cutoffs: dict[str, str],
    lead_minutes: int,
    last_sent: dict[str, str],
) -> list[str]:
    """Return meals whose automatic prompt window [cutoff - lead, cutoff) is open and not yet sent today."""
    due: list[str] = []
    today = now.date().isoformat()
    for meal in ("lunch", "dinner"):
        hh, mm = (int(x) for x in cutoffs[meal].split(":"))
        cutoff_dt = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if cutoff_dt - timedelta(minutes=lead_minutes) <= now < cutoff_dt and last_sent.get(meal) != today:
            due.append(meal)
    return due


def _auto_prompt_loop(lead_minutes: int, stop: threading.Event) -> None:
    last_sent: dict[str, str] = {}
    while not stop.wait(30):
        try:
            now = datetime.now()
            with db.get_connection() as conn:
                cutoffs = db.get_cutoff_settings(conn)
            for meal in due_auto_prompts(now, cutoffs, lead_minutes, last_sent):
                last_sent[meal] = now.date().isoformat()
                try:
                    res = send_meal_prompt(meal)
                    log.info("auto-prompt %s: sent %s / %s", meal, res["sent"], res["recipients"])
                    for err in res.get("errors", []):
                        log.warning("auto-prompt %s: batch failed: %s", meal, err)
                except (ValueError, RuntimeError) as exc:
                    log.warning("auto-prompt %s: skipped - %s", meal, exc)
        except Exception:  # keep the scheduler alive
            log.exception("auto-prompt loop error")


class TiffinHandler(BaseHTTPRequestHandler):
    """Serve static PWA assets and JSON REST API endpoints."""

    server_version = "DabbaTrack/1.1"
    timeout = REQUEST_TIMEOUT_S
    _response_started = False

    def log_message(self, format: str, *args: Any) -> None:
        # Request line only (paths carry no secrets: tokens go in headers, PINs in bodies).
        client = self.client_address[0] if self.client_address else "?"
        log.info("%s %s", client, format % args)

    def send_response(self, code: int, message: str | None = None) -> None:
        self._response_started = True
        super().send_response(code, message)

    def _send_error_json(self, message: str, status: int, headers: dict[str, str] | None = None) -> None:
        """Send an error reply unless part of a response already went out (then just close)."""
        self.close_connection = True
        if self._response_started:
            return
        try:
            self._send_json({"error": message}, status=status, headers=headers)
        except OSError:
            pass

    def end_headers(self) -> None:
        # Allow Expo (web/dev client) and other origins to call the JSON API.
        if self.path.startswith("/api/"):
            for key, value in CORS_HEADERS.items():
                self.send_header(key, value)
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        super().end_headers()

    @_guarded
    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_json(self, payload: Any, status: int = HTTPStatus.OK, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(
        self, data: bytes, content_type: str, status: int = HTTPStatus.OK, headers: dict[str, str] | None = None
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self) -> Any:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return {}
        try:
            length = int(raw_length)
        except ValueError:
            raise BadRequest(HTTPStatus.BAD_REQUEST, "Invalid Content-Length header")
        if length < 0:
            raise BadRequest(HTTPStatus.BAD_REQUEST, "Invalid Content-Length header")
        if length > MAX_BODY_BYTES:
            raise BadRequest(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body is too large")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            # parse_constant: refuse NaN / Infinity, which Python's json accepts by default.
            return json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
        except (UnicodeDecodeError, ValueError):  # JSONDecodeError is a ValueError
            raise BadRequest(HTTPStatus.BAD_REQUEST, "Invalid JSON payload")

    # ---- auth helpers ----

    def _bearer_token(self) -> str:
        header = self.headers.get("Authorization", "")
        return header[7:].strip() if header.lower().startswith("bearer ") else ""

    def _session(self) -> dict[str, Any] | None:
        token = self._bearer_token()
        if not token:
            return None
        with db.get_connection(immediate=False) as conn:  # read-only lookup; don't queue behind writers
            return db.get_session(conn, token)

    def _client_ip(self) -> str:
        if TRUST_PROXY:
            forwarded = self.headers.get("X-Forwarded-For", "")
            if forwarded:
                return forwarded.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "unknown"

    def _deny_unauthenticated(self) -> None:
        self._send_json({"error": "Please sign in again"}, status=HTTPStatus.UNAUTHORIZED)

    def _deny_forbidden(self) -> None:
        self._send_json({"error": "You don't have access to this"}, status=HTTPStatus.FORBIDDEN)

    def _gate(self, method: str, path: str) -> tuple[bool, dict[str, Any] | None]:
        """Authenticate and apply the role rule for a route. Returns (allowed, session)."""
        if (method, path) in PUBLIC_ROUTES or not path.startswith("/api/"):
            return True, None
        sess = self._session()
        if sess is None:
            self._deny_unauthenticated()
            return False, None
        needs_provider = True
        if method == "POST" and (path in CUSTOMER_POST_ROUTES or path in ANY_ROLE_POST_ROUTES):
            needs_provider = False
        if method == "GET":
            m = _CUSTOMER_PATH_RE.match(path)
            if m and m.group(2) == "summary":
                needs_provider = False
        if needs_provider and sess["role"] != "provider":
            self._deny_forbidden()
            return False, None
        return True, sess

    @staticmethod
    def _owned_customer_id(sess: dict[str, Any], raw_id: Any) -> int:
        """Parse a customer id and check the session may act on it (provider: anyone; customer: self)."""
        customer_id = int_field({"customer_id": raw_id}, "customer_id")
        if sess["role"] == "customer" and sess["customer_id"] != customer_id:
            raise Forbidden()
        return customer_id

    def _login_rate_limited(self, keys: list[str]) -> bool:
        wait = LOGIN_LIMITER.retry_after(keys)
        if wait:
            minutes = max(1, (wait + 59) // 60)
            self._send_json(
                {"error": f"Too many wrong PIN attempts. Try again in {minutes} min."},
                status=HTTPStatus.TOO_MANY_REQUESTS,
                headers={"Retry-After": str(wait)},
            )
            return True
        return False

    # ---- GET ----

    @_guarded
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        allowed, sess = self._gate("GET", path)
        if not allowed:
            return

        if path == "/api/health":
            self._send_json({"ok": True, "service": "DabbaTrack", "time": datetime.now().isoformat(timespec="seconds")})
            return

        if path == "/api/demo":
            if not DEMO_MODE:
                self._send_json({"enabled": False})
                return
            with db.get_connection() as conn:
                payload = {
                    "enabled": True,
                    "customers": db.get_demo_accounts(conn),
                    "provider_pin": db.DEFAULT_PROVIDER_PIN if db.provider_pin_is_default(conn) else None,
                    "provider_qr_code": db.get_provider_qr_code(conn),
                }
            self._send_json(payload)
            return

        m = _CUSTOMER_PATH_RE.match(path)
        if m and m.group(2) == "summary":
            try:
                customer_id = self._owned_customer_id(sess, m.group(1))
                with db.get_connection() as conn:
                    data = db.get_customer_summary(conn, customer_id)
            except Forbidden:
                self._deny_forbidden()
                return
            except (IndexError, ValueError) as exc:
                self._send_json({"error": str(exc) or "Invalid customer id"}, status=HTTPStatus.NOT_FOUND)
                return
            self._send_json(data)
            return

        if path == "/api/dashboard":
            params = parse_qs(parsed.query)
            target_date = params.get("date", [date.today().isoformat()])[0]
            try:
                date.fromisoformat(target_date)
            except ValueError:
                self._send_json({"error": "date must be YYYY-MM-DD"}, status=HTTPStatus.BAD_REQUEST)
                return
            with db.get_connection() as conn:
                data = db.get_dashboard_data(conn, target_date=target_date)
            self._send_json(data)
            return

        if path == "/api/qr.svg":
            params = parse_qs(parsed.query)
            with db.get_connection() as conn:
                code = params.get("code", [db.get_provider_qr_code(conn)])[0]
            try:
                svg = qr.render_qr_svg(code)
            except ValueError as exc:
                self._send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
                return
            self._send_bytes(svg.encode("utf-8"), "image/svg+xml; charset=utf-8")
            return

        if path.startswith("/api/"):
            self._send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
            return

        self._serve_static(path)

    # ---- POST ----

    @_guarded
    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        body = self._read_json_body()  # raises BadRequest (400/413), turned into a reply by @_guarded
        if not isinstance(body, dict):
            self._send_json({"error": "JSON body must be an object"}, status=HTTPStatus.BAD_REQUEST)
            return

        allowed, sess = self._gate("POST", path)
        if not allowed:
            return

        try:
            if path == "/api/customer/login":
                self._login_customer(body)
                return

            if path == "/api/provider/login":
                self._login_provider(body)
                return

            if path == "/api/auth/logout":
                with db.get_connection() as conn:
                    db.revoke_session(conn, self._bearer_token())
                self._send_json({"signed_out": True})
                return

            if path == "/api/push/send-meal-prompt":
                try:
                    res = send_meal_prompt(
                        body.get("meal_type", "lunch"),
                        meal_date=body.get("meal_date"),
                        dry_run=bool_field(body, "dry_run", False),
                    )
                except RuntimeError as exc:
                    self._send_json({"error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
                    return
                self._send_json(res)
                return

            is_provider = sess is not None and sess["role"] == "provider"

            with db.get_connection() as conn:
                if path == "/api/provider/pin":
                    db.set_provider_pin(conn, str_field(body, "current_pin"), str_field(body, "new_pin"))
                    # Sign out the provider on other devices; keep this one signed in.
                    db.revoke_sessions(conn, role="provider", keep_token=self._bearer_token())
                    self._send_json({"updated": True})
                    return

                if path == "/api/customers/push-token":
                    res = db.set_customer_push_token(
                        conn,
                        customer_id=self._owned_customer_id(sess, body["customer_id"]),
                        token=body.get("expo_push_token") or body.get("token"),
                    )
                    self._send_json(res)
                    return

                if path == "/api/customers":
                    pin = str_field(body, "pin") if body.get("pin") not in (None, "") else None
                    res = db.create_customer_with_subscription(
                        conn,
                        name=body["name"],
                        phone=body["phone"],
                        address=body["address"],
                        route_area=body.get("route_area", "General"),
                        plan_type=body["plan_type"],
                        total_diets=int_field(body, "total_diets"),
                        amount_paid=num_field(body, "amount_paid", 0),
                        start_date=body.get("start_date"),
                        payment_date=body.get("payment_date"),
                        pin=pin,
                    )
                    self._send_json(res, status=HTTPStatus.CREATED)
                    return

                m = _CUSTOMER_PATH_RE.match(path)
                if m and m.group(2) == "renew":
                    res = db.renew_subscription(
                        conn,
                        customer_id=int(m.group(1)),
                        plan_type=body["plan_type"],
                        diets_added=int_field(body, "diets_added"),
                        amount_paid=num_field(body, "amount_paid", 0),
                        start_date=body.get("start_date"),
                        payment_date=body.get("payment_date"),
                        notes=body.get("notes", "Renewal"),
                    )
                    self._send_json(res)
                    return

                if m and m.group(2) == "boxes":
                    customer_id = int(m.group(1))
                    count = db.adjust_customer_boxes(conn, customer_id, int_field(body, "delta"))
                    self._send_json({"customer_id": customer_id, "boxes_with_customer": count})
                    return

                if m and m.group(2) == "reset-pin":
                    new_pin = str_field(body, "pin") if body.get("pin") not in (None, "") else None
                    res = db.reset_customer_pin(conn, int(m.group(1)), new_pin)
                    self._send_json(res)
                    return

                if path == "/api/meals/respond":
                    res = db.respond_to_meal(
                        conn,
                        customer_id=self._owned_customer_id(sess, body["customer_id"]),
                        meal_date=body.get("meal_date", date.today().isoformat()),
                        meal_type=body["meal_type"],
                        wants_tiffin=bool_field(body, "wants_tiffin"),
                        bypass_cutoff=is_provider and bool_field(body, "bypass_cutoff", False),
                    )
                    self._send_json(res)
                    return

                if path == "/api/meals/pause":
                    res = db.pause_date_range(
                        conn,
                        customer_id=self._owned_customer_id(sess, body["customer_id"]),
                        start_date=body["start_date"],
                        end_date=body["end_date"],
                        meal_scope=body.get("meal_scope", "all"),
                        bypass_cutoff=is_provider and bool_field(body, "bypass_cutoff", False),
                    )
                    self._send_json(res)
                    return

                if path == "/api/meals/resume":
                    res = db.resume_paused_range(
                        conn,
                        customer_id=self._owned_customer_id(sess, body["customer_id"]),
                        start_date=body["start_date"],
                        end_date=body["end_date"],
                        bypass_cutoff=is_provider and bool_field(body, "bypass_cutoff", False),
                    )
                    self._send_json(res)
                    return

                if path == "/api/meals/scan-qr":
                    res = db.record_qr_delivery(
                        conn,
                        customer_id=self._owned_customer_id(sess, body["customer_id"]),
                        meal_date=body.get("meal_date", date.today().isoformat()),
                        meal_type=body["meal_type"],
                        qr_token=str_field(body, "qr_token"),
                        require_valid_qr=True,
                        box_returned=bool_field(body, "box_returned", False),
                    )
                    self._send_json(res)
                    return

                if path == "/api/meals/manual-deliver":
                    res = db.record_qr_delivery(
                        conn,
                        customer_id=int_field(body, "customer_id"),
                        meal_date=body.get("meal_date", date.today().isoformat()),
                        meal_type=body["meal_type"],
                        qr_token="MANUAL-PROVIDER-MARK",
                        require_valid_qr=False,
                        box_returned=bool_field(body, "box_returned", False),
                    )
                    self._send_json(res)
                    return

                if path == "/api/holidays":
                    res = db.add_holiday(
                        conn,
                        holiday_date=body["holiday_date"],
                        meal_scope=body["meal_scope"],
                        reason=body.get("reason", ""),
                    )
                    self._send_json(res, status=HTTPStatus.CREATED)
                    return

                if path == "/api/menus":
                    res = db.set_daily_menu(
                        conn,
                        menu_date=body.get("menu_date", date.today().isoformat()),
                        meal_type=body["meal_type"],
                        items_text=body["items_text"],
                    )
                    self._send_json(res)
                    return

                if path == "/api/settings/cutoffs":
                    res = db.set_cutoff_settings(
                        conn,
                        lunch_cutoff=body["lunch_cutoff"],
                        dinner_cutoff=body["dinner_cutoff"],
                    )
                    self._send_json(res)
                    return

                if path == "/api/popup-broadcast":
                    meal_type = body.get("meal_type", "lunch")
                    if meal_type not in ("lunch", "dinner"):
                        raise ValueError("meal_type must be 'lunch' or 'dinner'")
                    stamp = _set_broadcast(conn, meal_type)
                    self._send_json({"broadcast": stamp})
                    return

                if path == "/api/qr/rotate":
                    self._send_json({"provider_qr_code": db.rotate_provider_qr_code(conn)})
                    return

        except Forbidden:
            self._deny_forbidden()
            return
        except KeyError as exc:
            self._send_json({"error": f"Missing required field: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return
        except sqlite3.IntegrityError as exc:
            log.info("Rejected %s: %s", path, exc)
            self._send_json({"error": _friendly_integrity_error(exc)}, status=HTTPStatus.CONFLICT)
            return
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        except (TypeError, AttributeError) as exc:
            # Wrong JSON types (e.g. a number where text is expected).
            log.warning("Bad field types on %s: %s", path, exc)
            self._send_json({"error": "One of the fields has the wrong type"}, status=HTTPStatus.BAD_REQUEST)
            return

        self._send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def _login_customer(self, body: dict[str, Any]) -> None:
        phone = str(body.get("phone", "")).strip()
        pin = str(body.get("pin", "")).strip()
        ip_key, acct_key = f"ip:{self._client_ip()}", f"customer:{phone}"
        if self._login_rate_limited([ip_key, acct_key]):
            return
        with db.get_connection() as conn:
            cust = db.authenticate_customer(conn, phone, pin) if phone and pin else None
            if cust is None:
                LOGIN_LIMITER.record_failure({ip_key: IP_FAIL_LIMIT, acct_key: ACCOUNT_FAIL_LIMIT})
                self._send_json(
                    {"error": "Invalid phone number or 4-digit PIN"},
                    status=HTTPStatus.UNAUTHORIZED,
                )
                return
            session = db.create_session(conn, "customer", cust["id"])
        LOGIN_LIMITER.record_success([acct_key])
        self._send_json({"customer": cust, **session})

    def _login_provider(self, body: dict[str, Any]) -> None:
        pin = str(body.get("pin", "")).strip()
        ip = self._client_ip()
        ip_key, acct_key = f"ip:{ip}", f"provider:{ip}"
        if self._login_rate_limited([ip_key, acct_key]):
            return
        with db.get_connection() as conn:
            if not pin or not db.verify_provider_pin(conn, pin):
                LOGIN_LIMITER.record_failure({ip_key: IP_FAIL_LIMIT, acct_key: ACCOUNT_FAIL_LIMIT})
                self._send_json({"error": "Invalid provider PIN"}, status=HTTPStatus.UNAUTHORIZED)
                return
            session = db.create_session(conn, "provider")
        LOGIN_LIMITER.record_success([acct_key])
        self._send_json({"provider": True, **session})

    # ---- DELETE ----

    @_guarded
    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        allowed, _ = self._gate("DELETE", path)
        if not allowed:
            return
        if path.startswith("/api/holidays/"):
            try:
                holiday_id = int(path.split("/")[3])
            except (IndexError, ValueError):
                self._send_json({"error": "Invalid holiday id"}, status=HTTPStatus.BAD_REQUEST)
                return
            with db.get_connection() as conn:
                db.remove_holiday(conn, holiday_id)
            self._send_json({"deleted": holiday_id})
            return

        self._send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def _serve_static(self, req_path: str) -> None:
        clean = "index.html" if req_path in ("", "/") else req_path.lstrip("/")
        file_path = (STATIC_DIR / clean).resolve()
        if not file_path.is_relative_to(STATIC_DIR.resolve()) or not file_path.is_file():
            self._send_json({"error": "File not found"}, status=HTTPStatus.NOT_FOUND)
            return

        mime_type, _ = mimetypes.guess_type(str(file_path))
        if file_path.suffix == ".js":
            mime_type = "application/javascript; charset=utf-8"
        elif file_path.suffix == ".json":
            mime_type = "application/manifest+json; charset=utf-8"
        elif file_path.suffix == ".css":
            mime_type = "text/css; charset=utf-8"
        elif file_path.suffix == ".html":
            mime_type = "text/html; charset=utf-8"

        # no-cache = always revalidate, so app updates reach users right away.
        extra = {"Cache-Control": "no-cache"}
        if file_path.suffix == ".html":
            extra.update(HTML_SECURITY_HEADERS)
        self._send_bytes(file_path.read_bytes(), mime_type or "application/octet-stream", headers=extra)


class DabbaServer(ThreadingHTTPServer):
    allow_reuse_address = True
    # Non-daemon request threads + block_on_close: on shutdown, server_close() waits for in-flight
    # requests to finish (each is bounded by REQUEST_TIMEOUT_S) instead of killing them mid-write.
    daemon_threads = False
    block_on_close = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        log.exception("Connection error from %s", client_address[0] if client_address else "?")


def clock_is_utc_by_default() -> bool:
    """True when local time is UTC only because nobody chose a zone (typical for cloud hosts)."""
    offset = datetime.now().astimezone().utcoffset()
    return offset == timedelta(0) and not os.environ.get("TZ", "").strip()


def check_startup_security() -> None:
    """Refuse to serve real users with the public default provider PIN."""
    if DEMO_MODE:
        log.warning("DEMO_MODE is ON: demo customers and their PINs are public at /api/demo. Do not use with real users.")
        return
    env_pin = os.environ.get("PROVIDER_PIN", "").strip()
    if env_pin and (not re.fullmatch(r"\d{4,8}", env_pin) or env_pin == db.DEFAULT_PROVIDER_PIN):
        raise SystemExit("PROVIDER_PIN must be 4-8 digits and not 0000.")
    with db.get_connection() as conn:
        if db.provider_pin_is_default(conn):
            raise SystemExit(
                "No provider PIN is set. Start with PROVIDER_PIN=<4-8 digits> "
                "(you can change it later in the app), or DEMO_MODE=1 for a local demo."
            )


def run_server(host: str = "127.0.0.1", port: int = 8080, auto_prompt_lead: int = 0) -> None:
    """Initialize the DB (seeding demo data only in DEMO_MODE) and start the HTTP server."""
    configure_logging()
    Path(db.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    db.init_db()
    if DEMO_MODE:
        db.seed_demo_data()
    check_startup_security()
    server = DabbaServer((host, port), TiffinHandler)
    shown_host = "localhost" if host in ("0.0.0.0", "::", "") else host
    log.info("DabbaTrack API + PWA listening on %s:%s -> http://%s:%s", host, port, shown_host, port)
    log.info("Database: %s", Path(db.DB_PATH).resolve())
    log.info("Server time zone: %s (cutoffs and 'today' use this clock)", time.strftime("%Z %z"))
    if clock_is_utc_by_default():
        log.warning(
            "Server clock is UTC and TZ is not set: a 10:00 cutoff will fire at 10:00 UTC (15:30 IST). "
            "Set TZ=Asia/Kolkata (or your business time zone)."
        )
    if host in ("127.0.0.1", "localhost"):
        log.info("Tip: set HOST=0.0.0.0 so phones on your Wi-Fi can reach this server.")

    # SIGTERM (docker stop, systemd, most hosts) -> stop accepting, finish in-flight requests, exit.
    def _on_sigterm(signum: int, _frame: Any) -> None:
        log.info("Received signal %s, shutting down", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    if hasattr(signal, "SIGTERM"):
        try:
            signal.signal(signal.SIGTERM, _on_sigterm)
        except ValueError:  # not in the main thread (e.g. embedded in tests)
            pass

    stop = threading.Event()
    if auto_prompt_lead > 0:
        threading.Thread(target=_auto_prompt_loop, args=(auto_prompt_lead, stop), daemon=True).start()
        log.info("Auto meal prompts: %s min before each cutoff", auto_prompt_lead)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down server")
    finally:
        stop.set()
        server.server_close()
        log.info("Server stopped")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise SystemExit(f"{name} must be an integer, got {raw!r}")


if __name__ == "__main__":
    run_server(
        host=os.environ.get("HOST", "127.0.0.1").strip() or "127.0.0.1",
        port=_env_int("PORT", 8080),
        auto_prompt_lead=_env_int("AUTO_PROMPT_LEAD_MINUTES", 0),
    )
