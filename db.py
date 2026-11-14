"""Database layer and core business logic for DabbaTrack Tiffin Service PWA."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

# DB_PATH env lets production keep data outside the code folder (e.g. a Docker volume at /data/tiffin.db).
DB_PATH = Path(os.environ.get("DB_PATH", "").strip() or Path(__file__).parent / "tiffin.db")

PLAN_MEALS: dict[str, tuple[str, ...]] = {
    "lunch_only": ("lunch",),
    "dinner_only": ("dinner",),
    "both": ("lunch", "dinner"),
}

DEFAULT_CUTOFFS = {
    "lunch": "10:00",
    "dinner": "17:30",
}

_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


# ---------------------------------------------------------------------------
# Input validation (applied at every write; existing rows are not rewritten)
# ---------------------------------------------------------------------------

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
DATE_WINDOW_DAYS = 730  # dates must fall within ±2 years of today
MAX_DIETS = 1000
MAX_AMOUNT = 1_000_000
MAX_BOX_DELTA = 100
LIMITS = {"name": 80, "address": 200, "route_area": 60, "menu": 500, "reason": 120, "notes": 200, "qr": 64}


def clean_text(value: Any, field: str, *, max_len: int, required: bool = True) -> str:
    """Trimmed text with a length cap; rejects control characters (newlines and tabs are fine)."""
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be text")
    cleaned = value.strip()
    if required and not cleaned:
        raise ValueError(f"{field} is required")
    if len(cleaned) > max_len:
        raise ValueError(f"{field} must be at most {max_len} characters")
    if _CONTROL_CHARS_RE.search(cleaned):
        raise ValueError(f"{field} contains invalid characters")
    return cleaned


def clean_date(value: Any, field: str, *, around: date | None = None) -> str:
    """Strict YYYY-MM-DD within ±2 years of `around` (default today). Returns the ISO string."""
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value.strip()):
        raise ValueError(f"{field} must be a date like 2026-11-14")
    try:
        parsed = date.fromisoformat(value.strip())
    except ValueError:
        raise ValueError(f"{field} is not a real date")
    if abs((parsed - (around or date.today())).days) > DATE_WINDOW_DAYS:
        raise ValueError(f"{field} must be within 2 years of today")
    return parsed.isoformat()


def clean_phone(value: Any) -> str:
    """Indian 10-digit mobile number. Accepts spaces/dashes and a +91 / 0 prefix; returns 10 digits."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError("Phone number must be 10 digits")
    digits = re.sub(r"[\s\-()]", "", str(value))
    if digits.startswith("+91"):
        digits = digits[3:]
    elif len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if not re.fullmatch(r"\d{10}", digits):
        raise ValueError("Phone number must be 10 digits")
    return digits


def clean_count(value: int, field: str, *, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{field} must be a whole number from {low} to {high}")
    return value


def clean_amount(value: float, field: str = "amount_paid") -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:  # NaN != NaN
        raise ValueError(f"{field} must be a number")
    if not 0 <= value <= MAX_AMOUNT:
        raise ValueError(f"{field} must be between 0 and {MAX_AMOUNT:,}")
    return round(float(value), 2)


def _check_meal_type(meal_type: Any) -> None:
    if meal_type not in ("lunch", "dinner"):
        raise ValueError("meal_type must be 'lunch' or 'dinner'")


@contextmanager
def get_connection(db_path: Path | str | None = None, *, immediate: bool = True) -> Iterator[sqlite3.Connection]:
    """Yield a SQLite connection, committing on success, rolling back on error, always closing.

    immediate=True (default) wraps the whole block in BEGIN IMMEDIATE, so read-check-write logic
    (diet counts, box counts, "already delivered?") runs as one serialized unit: two concurrent requests
    can't both read the same value and overwrite each other. Readers still proceed under WAL.
    immediate=False keeps sqlite3's legacy implicit transactions (needed for PRAGMA journal_mode and
    schema migration, and fine for pure reads).
    """
    target = db_path if db_path is not None else DB_PATH
    # timeout: wait up to 10 s for another thread's write lock instead of failing with "database is locked".
    conn = sqlite3.connect(str(target), timeout=10, isolation_level=None if immediate else "")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        if immediate:
            conn.execute("BEGIN IMMEDIATE")
        yield conn
        if conn.in_transaction:
            conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def _column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {r["name"] for r in rows}


def _migrate_db(conn: sqlite3.Connection) -> None:
    """Apply idempotent schema upgrades for existing databases."""
    cust_cols = _column_names(conn, "customers")
    if "route_area" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN route_area TEXT NOT NULL DEFAULT 'General'")
    if "boxes_with_customer" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN boxes_with_customer INTEGER NOT NULL DEFAULT 0")
    if "expo_push_token" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN expo_push_token TEXT")
    if "push_token_updated_at" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN push_token_updated_at TEXT")

    ml_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'meal_logs'"
    ).fetchone()
    if ml_row and "'paused'" not in (ml_row["sql"] or ""):
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.executescript(
            """
            CREATE TABLE meal_logs_v2 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
                meal_date TEXT NOT NULL,
                meal_type TEXT NOT NULL CHECK (meal_type IN ('lunch', 'dinner')),
                status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'paused', 'delivered')),
                responded_at TEXT,
                delivered_at TEXT,
                qr_token TEXT,
                UNIQUE(subscription_id, meal_date, meal_type)
            );
            INSERT INTO meal_logs_v2 (id, customer_id, subscription_id, meal_date, meal_type, status, responded_at, delivered_at, qr_token)
            SELECT id, customer_id, subscription_id, meal_date, meal_type, status, responded_at, delivered_at, qr_token FROM meal_logs;
            DROP TABLE meal_logs;
            ALTER TABLE meal_logs_v2 RENAME TO meal_logs;
            """
        )
        conn.execute("PRAGMA foreign_keys = ON")

    # Security upgrade: hash any PINs still stored in plain text (one-way, idempotent).
    for row in conn.execute("SELECT id, pin FROM customers WHERE pin NOT LIKE 'scrypt$%'").fetchall():
        conn.execute("UPDATE customers SET pin = ? WHERE id = ?", (hash_pin(row["pin"]), row["id"]))
    prow = conn.execute("SELECT value FROM app_settings WHERE key = 'provider_pin'").fetchone()
    if prow and prow["value"] and not prow["value"].startswith("scrypt$"):
        conn.execute(
            "UPDATE app_settings SET value = ? WHERE key = 'provider_pin'", (hash_pin(prow["value"]),)
        )
    # The old hardcoded default QR code is public (it was in the source), so replace it.
    qrow = conn.execute("SELECT value FROM app_settings WHERE key = 'provider_qr_code'").fetchone()
    if qrow and qrow["value"] == LEGACY_DEFAULT_QR:
        conn.execute(
            "UPDATE app_settings SET value = ? WHERE key = 'provider_qr_code'", (_new_qr_code(),)
        )


def init_db(db_path: Path | str | None = None) -> None:
    """Create tables if they do not exist and apply lightweight migrations."""
    with get_connection(db_path, immediate=False) as conn:
        # WAL lets readers work while one thread writes (the threaded server + auto-prompt thread).
        # It is stored in the DB file, so this only needs to run once; NORMAL sync is safe with WAL.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL UNIQUE,
                address TEXT NOT NULL,
                route_area TEXT NOT NULL DEFAULT 'General',
                boxes_with_customer INTEGER NOT NULL DEFAULT 0,
                pin TEXT NOT NULL DEFAULT '1234',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                expo_push_token TEXT,
                push_token_updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                plan_type TEXT NOT NULL CHECK (plan_type IN ('lunch_only', 'dinner_only', 'both')),
                total_diets INTEGER NOT NULL CHECK (total_diets > 0),
                diets_consumed INTEGER NOT NULL DEFAULT 0 CHECK (diets_consumed >= 0),
                amount_paid REAL NOT NULL DEFAULT 0,
                payment_date TEXT NOT NULL,
                start_date TEXT NOT NULL,
                estimated_end_date TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS meal_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
                meal_date TEXT NOT NULL,
                meal_type TEXT NOT NULL CHECK (meal_type IN ('lunch', 'dinner')),
                status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'paused', 'delivered')),
                responded_at TEXT,
                delivered_at TEXT,
                qr_token TEXT,
                UNIQUE(subscription_id, meal_date, meal_type)
            );

            CREATE TABLE IF NOT EXISTS holidays (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                holiday_date TEXT NOT NULL,
                meal_scope TEXT NOT NULL CHECK (meal_scope IN ('full_day', 'lunch', 'dinner')),
                reason TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                UNIQUE(holiday_date, meal_scope)
            );

            CREATE TABLE IF NOT EXISTS daily_menus (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                menu_date TEXT NOT NULL,
                meal_type TEXT NOT NULL CHECK (meal_type IN ('lunch', 'dinner')),
                items_text TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(menu_date, meal_type)
            );

            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
                amount REAL NOT NULL,
                diets_added INTEGER NOT NULL,
                plan_type TEXT NOT NULL,
                paid_at TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                role TEXT NOT NULL CHECK (role IN ('provider', 'customer')),
                customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );
            """
        )
        _migrate_db(conn)


def _holiday_covers_meal(holiday_rows: list[sqlite3.Row], check_date: str, meal_type: str) -> bool:
    """Return True if a provider holiday covers the given date and meal."""
    for row in holiday_rows:
        if row["holiday_date"] == check_date and row["meal_scope"] in ("full_day", meal_type):
            return True
    return False


def calculate_estimated_end_date(
    conn: sqlite3.Connection,
    subscription_id: int,
    reference_date: date | None = None,
) -> str:
    """Calculate the estimated end date for a subscription, extending automatically
    for customer cancellations, vacation pauses, and provider holidays."""
    sub = conn.execute(
        "SELECT * FROM subscriptions WHERE id = ?", (subscription_id,)
    ).fetchone()
    if sub is None:
        raise ValueError(f"Subscription {subscription_id} not found")

    remaining = max(0, sub["total_diets"] - sub["diets_consumed"])
    start_dt = date.fromisoformat(sub["start_date"])
    ref_dt = reference_date or date.today()

    if remaining == 0:
        last_deliv = conn.execute(
            """
            SELECT MAX(meal_date) AS last_date
            FROM meal_logs
            WHERE subscription_id = ? AND status = 'delivered'
            """,
            (subscription_id,),
        ).fetchone()
        if last_deliv and last_deliv["last_date"]:
            return last_deliv["last_date"]
        return sub["start_date"]

    holidays = conn.execute(
        "SELECT holiday_date, meal_scope FROM holidays WHERE holiday_date >= ?",
        (min(start_dt, ref_dt).isoformat(),),
    ).fetchall()

    logs_rows = conn.execute(
        """
        SELECT meal_date, meal_type, status
        FROM meal_logs
        WHERE subscription_id = ? AND meal_date >= ?
        """,
        (subscription_id, min(start_dt, ref_dt).isoformat()),
    ).fetchall()
    log_map = {(r["meal_date"], r["meal_type"]): r["status"] for r in logs_rows}

    plan_meals = PLAN_MEALS[sub["plan_type"]]
    cursor = max(start_dt, ref_dt)
    allocated = 0
    max_days = remaining * 10 + 365
    last_meal_date = cursor

    for _ in range(max_days):
        day_str = cursor.isoformat()
        for meal in plan_meals:
            if _holiday_covers_meal(holidays, day_str, meal):
                continue
            status = log_map.get((day_str, meal), "pending")
            if status in ("cancelled", "paused", "delivered"):
                continue
            allocated += 1
            last_meal_date = cursor
            if allocated >= remaining:
                return last_meal_date.isoformat()
        cursor += timedelta(days=1)

    return last_meal_date.isoformat()


def recalculate_all_end_dates(
    conn: sqlite3.Connection,
    reference_date: date | None = None,
) -> None:
    """Recalculate estimated_end_date for all active subscriptions."""
    subs = conn.execute("SELECT id FROM subscriptions WHERE is_active = 1").fetchall()
    for sub in subs:
        new_end = calculate_estimated_end_date(conn, sub["id"], reference_date=reference_date)
        conn.execute(
            "UPDATE subscriptions SET estimated_end_date = ? WHERE id = ?",
            (new_end, sub["id"]),
        )


LEGACY_DEFAULT_QR = "TIFFIN-DABBA-01"


def _new_qr_code() -> str:
    """Unguessable QR payload. 23 chars, fits QR version 2 (byte mode, ECC L)."""
    return f"TIFFIN-{secrets.token_urlsafe(12)}"


def get_provider_qr_code(conn: sqlite3.Connection) -> str:
    """Return the active provider QR payload, creating a random one on first use."""
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = 'provider_qr_code'"
    ).fetchone()
    if row:
        return row["value"]
    return rotate_provider_qr_code(conn)


def rotate_provider_qr_code(conn: sqlite3.Connection) -> str:
    """Replace the provider QR payload with a new random one and return it."""
    code = _new_qr_code()
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('provider_qr_code', ?)",
        (code,),
    )
    return code


# ---------------------------------------------------------------------------
# PIN hashing and login sessions
# ---------------------------------------------------------------------------

_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2**14, 8, 1
_CUSTOMER_PIN_RE = re.compile(r"^\d{4}$")
_PROVIDER_PIN_RE = re.compile(r"^\d{4,8}$")
SESSION_TTL = {"customer": timedelta(days=30), "provider": timedelta(days=7)}


def hash_pin(pin: str) -> str:
    """Return a salted scrypt hash string: scrypt$n$r$p$salt_hex$hash_hex."""
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(
        str(pin).strip().encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=32
    )
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${dk.hex()}"


def verify_pin(pin: str, stored: str) -> bool:
    """Constant-time check of a PIN against a stored hash (or a legacy plain-text value)."""
    candidate = str(pin).strip().encode("utf-8")
    if not stored.startswith("scrypt$"):
        return hmac.compare_digest(candidate, stored.strip().encode("utf-8"))
    try:
        _, n, r, p, salt_hex, hash_hex = stored.split("$")
        dk = hashlib.scrypt(
            candidate, salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p), dklen=len(hash_hex) // 2
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk.hex(), hash_hex)


_DUMMY_PIN_HASH = hash_pin("not-a-real-pin")


def _validate_customer_pin(pin: str) -> str:
    cleaned = str(pin).strip()
    if not _CUSTOMER_PIN_RE.fullmatch(cleaned):
        raise ValueError("Customer PIN must be exactly 4 digits")
    return cleaned


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(
    conn: sqlite3.Connection, role: str, customer_id: int | None = None, now_dt: datetime | None = None
) -> dict[str, str]:
    """Issue a random bearer token. Only its SHA-256 hash is stored."""
    if role not in SESSION_TTL:
        raise ValueError("Invalid role")
    now = now_dt or datetime.now()
    conn.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now.isoformat(timespec="seconds"),))
    token = secrets.token_urlsafe(32)
    expires = (now + SESSION_TTL[role]).isoformat(timespec="seconds")
    conn.execute(
        """
        INSERT INTO auth_sessions (token_hash, role, customer_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (_token_hash(token), role, customer_id, now.isoformat(timespec="seconds"), expires),
    )
    return {"token": token, "expires_at": expires}


def get_session(conn: sqlite3.Connection, token: str, now_dt: datetime | None = None) -> dict[str, Any] | None:
    """Return {'role', 'customer_id'} for a valid, unexpired token (customer must still be active)."""
    if not token:
        return None
    row = conn.execute(
        """
        SELECT s.role, s.customer_id, s.expires_at
        FROM auth_sessions s
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.token_hash = ? AND (s.role = 'provider' OR c.active = 1)
        """,
        (_token_hash(token),),
    ).fetchone()
    now_iso = (now_dt or datetime.now()).isoformat(timespec="seconds")
    if row is None or row["expires_at"] <= now_iso:
        return None
    return {"role": row["role"], "customer_id": row["customer_id"]}


def revoke_session(conn: sqlite3.Connection, token: str) -> None:
    conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (_token_hash(token),))


def revoke_sessions(
    conn: sqlite3.Connection, *, role: str, customer_id: int | None = None, keep_token: str | None = None
) -> None:
    """Sign out every session for a role (optionally one customer), except keep_token."""
    keep = _token_hash(keep_token) if keep_token else ""
    if role == "customer":
        conn.execute(
            "DELETE FROM auth_sessions WHERE role = 'customer' AND customer_id = ? AND token_hash != ?",
            (customer_id, keep),
        )
    else:
        conn.execute("DELETE FROM auth_sessions WHERE role = 'provider' AND token_hash != ?", (keep,))


def reset_customer_pin(conn: sqlite3.Connection, customer_id: int, new_pin: str | None = None) -> dict[str, Any]:
    """Set (or randomly generate) a customer's 4-digit PIN and sign out their devices.

    Returns the new PIN once so the provider can share it; it is never retrievable later.
    """
    pin = _validate_customer_pin(new_pin) if new_pin else f"{secrets.randbelow(10000):04d}"
    cur = conn.execute("UPDATE customers SET pin = ? WHERE id = ?", (hash_pin(pin), customer_id))
    if cur.rowcount == 0:
        raise ValueError(f"Customer {customer_id} not found")
    revoke_sessions(conn, role="customer", customer_id=customer_id)
    return {"customer_id": customer_id, "pin": pin}


def get_cutoff_settings(conn: sqlite3.Connection) -> dict[str, str]:
    """Return configured HH:MM cutoff times for lunch and dinner."""
    out = dict(DEFAULT_CUTOFFS)
    for meal in ("lunch", "dinner"):
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = ?",
            (f"{meal}_cutoff",),
        ).fetchone()
        if row and _TIME_RE.match(row["value"]):
            out[meal] = row["value"]
    return out


def set_cutoff_settings(
    conn: sqlite3.Connection,
    lunch_cutoff: str,
    dinner_cutoff: str,
) -> dict[str, str]:
    """Validate and persist lunch and dinner cutoff times (HH:MM)."""
    lunch = lunch_cutoff.strip()
    dinner = dinner_cutoff.strip()
    if not _TIME_RE.match(lunch) or not _TIME_RE.match(dinner):
        raise ValueError("Cutoff times must be in 24-hour HH:MM format (e.g. 10:00 and 17:30)")
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('lunch_cutoff', ?)",
        (lunch,),
    )
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('dinner_cutoff', ?)",
        (dinner,),
    )
    return {"lunch": lunch, "dinner": dinner}


def is_meal_locked(
    conn: sqlite3.Connection,
    meal_date: str,
    meal_type: str,
    now_dt: datetime | None = None,
) -> tuple[bool, str]:
    """Return (locked, reason) if the cutoff time for meal_date + meal_type has passed."""
    current = now_dt or datetime.now()
    today_str = current.date().isoformat()
    if meal_date < today_str:
        return True, f"Past date ({meal_date}) is locked"
    if meal_date == today_str:
        cutoffs = get_cutoff_settings(conn)
        cutoff = cutoffs[meal_type]
        if current.strftime("%H:%M") >= cutoff:
            return True, f"Cutoff time ({cutoff}) has passed for today's {meal_type}"
    return False, ""


def set_daily_menu(
    conn: sqlite3.Connection,
    *,
    menu_date: str,
    meal_type: str,
    items_text: str,
) -> dict[str, str]:
    """Publish or update the menu for a specific date and meal."""
    _check_meal_type(meal_type)
    menu_date = clean_date(menu_date, "menu_date")
    if isinstance(items_text, str) and not items_text.strip():
        raise ValueError("Menu description cannot be empty")
    cleaned = clean_text(items_text, "Menu", max_len=LIMITS["menu"])
    now_iso = datetime.now().isoformat(timespec="seconds")
    conn.execute(
        """
        INSERT INTO daily_menus (menu_date, meal_type, items_text, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(menu_date, meal_type)
        DO UPDATE SET items_text = excluded.items_text, updated_at = excluded.updated_at
        """,
        (menu_date, meal_type, cleaned, now_iso),
    )
    return {"menu_date": menu_date, "meal_type": meal_type, "items_text": cleaned}


def get_daily_menus(conn: sqlite3.Connection, menu_date: str) -> dict[str, str]:
    """Return published lunch and dinner menus for the target date."""
    rows = conn.execute(
        "SELECT meal_type, items_text FROM daily_menus WHERE menu_date = ?",
        (menu_date,),
    ).fetchall()
    menus = {"lunch": "", "dinner": ""}
    for r in rows:
        menus[r["meal_type"]] = r["items_text"]
    return menus


def authenticate_customer(conn: sqlite3.Connection, phone: str, pin: str) -> dict[str, Any] | None:
    """Verify customer phone + PIN and return customer record (without the PIN) if valid."""
    raw = str(phone).strip()
    try:
        normalized = clean_phone(raw)
    except ValueError:
        normalized = raw
    # Match the normalized form, and the raw form for rows saved before phone validation existed.
    row = conn.execute(
        """
        SELECT id, name, phone, address, route_area, boxes_with_customer, pin
        FROM customers
        WHERE phone IN (?, ?) AND active = 1
        ORDER BY phone = ? DESC
        LIMIT 1
        """,
        (normalized, raw, normalized),
    ).fetchone()
    if row is None:
        verify_pin(pin, _DUMMY_PIN_HASH)  # same work either way, so timing doesn't reveal valid phones
        return None
    if not verify_pin(pin, row["pin"]):
        return None
    out = dict(row)
    out.pop("pin")
    return out


def adjust_customer_boxes(conn: sqlite3.Connection, customer_id: int, delta: int) -> int:
    """Increment or decrement empty boxes held by a customer, clamped at 0."""
    clean_count(delta, "delta", low=-MAX_BOX_DELTA, high=MAX_BOX_DELTA)
    row = conn.execute(
        "SELECT boxes_with_customer FROM customers WHERE id = ?",
        (customer_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"Customer {customer_id} not found")
    new_count = max(0, row["boxes_with_customer"] + delta)
    conn.execute(
        "UPDATE customers SET boxes_with_customer = ? WHERE id = ?",
        (new_count, customer_id),
    )
    return new_count


def create_customer_with_subscription(
    conn: sqlite3.Connection,
    *,
    name: str,
    phone: str,
    address: str,
    plan_type: str,
    total_diets: int,
    amount_paid: float,
    route_area: str = "General",
    start_date: str | None = None,
    payment_date: str | None = None,
    pin: str | None = None,
    reference_date: date | None = None,
) -> dict[str, Any]:
    """Create a new customer and their initial active subscription.

    If no PIN is given a random 4-digit PIN is generated. The plain PIN is returned once in the result.
    """
    pin = _validate_customer_pin(pin) if pin else f"{secrets.randbelow(10000):04d}"
    if plan_type not in PLAN_MEALS:
        raise ValueError(f"Invalid plan_type: {plan_type}")
    if isinstance(total_diets, int) and not isinstance(total_diets, bool) and total_diets <= 0:
        raise ValueError("total_diets must be positive")
    clean_count(total_diets, "total_diets", low=1, high=MAX_DIETS)
    amount_paid = clean_amount(amount_paid)
    name = clean_text(name, "Name", max_len=LIMITS["name"])
    phone = clean_phone(phone)
    address = clean_text(address, "Address", max_len=LIMITS["address"])
    area = clean_text(route_area, "Area", max_len=LIMITS["route_area"], required=False) or "General"

    now_iso = datetime.now().isoformat(timespec="seconds")
    ref = reference_date or date.today()
    today_str = ref.isoformat()
    start_str = clean_date(start_date, "start_date", around=ref) if start_date else today_str
    pay_str = clean_date(payment_date, "payment_date", around=ref) if payment_date else today_str

    cur = conn.execute(
        """
        INSERT INTO customers (name, phone, address, route_area, boxes_with_customer, pin, created_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)
        """,
        (name, phone, address, area, hash_pin(pin), now_iso),
    )
    customer_id = cur.lastrowid

    sub_cur = conn.execute(
        """
        INSERT INTO subscriptions (
            customer_id, plan_type, total_diets, diets_consumed,
            amount_paid, payment_date, start_date, estimated_end_date,
            is_active, created_at
        ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, ?)
        """,
        (customer_id, plan_type, total_diets, amount_paid, pay_str, start_str, start_str, now_iso),
    )
    sub_id = sub_cur.lastrowid

    end_date = calculate_estimated_end_date(conn, sub_id, reference_date=reference_date)
    conn.execute(
        "UPDATE subscriptions SET estimated_end_date = ? WHERE id = ?",
        (end_date, sub_id),
    )

    conn.execute(
        """
        INSERT INTO payments (customer_id, subscription_id, amount, diets_added, plan_type, paid_at, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (customer_id, sub_id, amount_paid, total_diets, plan_type, pay_str, "Initial plan"),
    )

    return {"customer_id": customer_id, "subscription_id": sub_id, "estimated_end_date": end_date, "pin": pin}


def renew_subscription(
    conn: sqlite3.Connection,
    *,
    customer_id: int,
    plan_type: str,
    diets_added: int,
    amount_paid: float,
    start_date: str | None = None,
    payment_date: str | None = None,
    notes: str = "Renewal",
    reference_date: date | None = None,
) -> dict[str, Any]:
    """Add a new paid subscription (or top-up diets) for an existing customer."""
    if plan_type not in PLAN_MEALS:
        raise ValueError(f"Invalid plan_type: {plan_type}")
    if isinstance(diets_added, int) and not isinstance(diets_added, bool) and diets_added <= 0:
        raise ValueError("diets_added must be positive")
    clean_count(diets_added, "diets_added", low=1, high=MAX_DIETS)
    amount_paid = clean_amount(amount_paid)
    notes = clean_text(notes, "Notes", max_len=LIMITS["notes"], required=False) or "Renewal"

    now_iso = datetime.now().isoformat(timespec="seconds")
    ref = reference_date or date.today()
    today_str = ref.isoformat()
    pay_str = clean_date(payment_date, "payment_date", around=ref) if payment_date else today_str
    if start_date:
        start_date = clean_date(start_date, "start_date", around=ref)

    active = conn.execute(
        "SELECT * FROM subscriptions WHERE customer_id = ? AND is_active = 1",
        (customer_id,),
    ).fetchone()

    if active and active["plan_type"] == plan_type:
        new_total = active["total_diets"] + diets_added
        new_paid = active["amount_paid"] + amount_paid
        conn.execute(
            """
            UPDATE subscriptions
            SET total_diets = ?, amount_paid = ?, payment_date = ?
            WHERE id = ?
            """,
            (new_total, new_paid, pay_str, active["id"]),
        )
        sub_id = active["id"]
    else:
        if active:
            conn.execute(
                "UPDATE subscriptions SET is_active = 0 WHERE id = ?",
                (active["id"],),
            )
        start_str = start_date or today_str
        cur = conn.execute(
            """
            INSERT INTO subscriptions (
                customer_id, plan_type, total_diets, diets_consumed,
                amount_paid, payment_date, start_date, estimated_end_date,
                is_active, created_at
            ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, ?)
            """,
            (customer_id, plan_type, diets_added, amount_paid, pay_str, start_str, start_str, now_iso),
        )
        sub_id = cur.lastrowid

    end_date = calculate_estimated_end_date(conn, sub_id, reference_date=reference_date)
    conn.execute(
        "UPDATE subscriptions SET estimated_end_date = ? WHERE id = ?",
        (end_date, sub_id),
    )

    conn.execute(
        """
        INSERT INTO payments (customer_id, subscription_id, amount, diets_added, plan_type, paid_at, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (customer_id, sub_id, amount_paid, diets_added, plan_type, pay_str, notes),
    )

    return {"subscription_id": sub_id, "estimated_end_date": end_date}


def respond_to_meal(
    conn: sqlite3.Connection,
    *,
    customer_id: int,
    meal_date: str,
    meal_type: str,
    wants_tiffin: bool,
    now_dt: datetime | None = None,
    bypass_cutoff: bool = False,
    reference_date: date | None = None,
) -> dict[str, Any]:
    """Record a customer's pop-up response (Yes / Cancel) for a specific date & meal."""
    _check_meal_type(meal_type)
    meal_date = clean_date(meal_date, "meal_date", around=reference_date or (now_dt.date() if now_dt else None))

    if not bypass_cutoff:
        locked, reason = is_meal_locked(conn, meal_date, meal_type, now_dt=now_dt)
        if locked:
            raise ValueError(reason)

    sub = conn.execute(
        "SELECT * FROM subscriptions WHERE customer_id = ? AND is_active = 1",
        (customer_id,),
    ).fetchone()
    if not sub:
        raise ValueError("No active subscription for customer")
    if meal_type not in PLAN_MEALS[sub["plan_type"]]:
        raise ValueError(f"Plan '{sub['plan_type']}' does not include '{meal_type}'")

    existing = conn.execute(
        """
        SELECT * FROM meal_logs
        WHERE subscription_id = ? AND meal_date = ? AND meal_type = ?
        """,
        (sub["id"], meal_date, meal_type),
    ).fetchone()
    if existing and existing["status"] == "delivered":
        raise ValueError("Meal already delivered and QR scanned")

    new_status = "confirmed" if wants_tiffin else "cancelled"
    now_iso = (now_dt or datetime.now()).isoformat(timespec="seconds")
    ref = reference_date or (now_dt.date() if now_dt else date.today())

    conn.execute(
        """
        INSERT INTO meal_logs (customer_id, subscription_id, meal_date, meal_type, status, responded_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id, meal_date, meal_type)
        DO UPDATE SET status = excluded.status, responded_at = excluded.responded_at
        """,
        (customer_id, sub["id"], meal_date, meal_type, new_status, now_iso),
    )

    new_end = calculate_estimated_end_date(conn, sub["id"], reference_date=ref)
    conn.execute(
        "UPDATE subscriptions SET estimated_end_date = ? WHERE id = ?",
        (new_end, sub["id"]),
    )
    return {
        "status": new_status,
        "meal_date": meal_date,
        "meal_type": meal_type,
        "estimated_end_date": new_end,
    }


def pause_date_range(
    conn: sqlite3.Connection,
    *,
    customer_id: int,
    start_date: str,
    end_date: str,
    meal_scope: str = "all",
    now_dt: datetime | None = None,
    bypass_cutoff: bool = False,
    reference_date: date | None = None,
) -> dict[str, Any]:
    """Pause eligible meals across a date range and extend the subscription end date."""
    if meal_scope not in ("all", "lunch", "dinner"):
        raise ValueError("meal_scope must be 'all', 'lunch', or 'dinner'")

    around = reference_date or (now_dt.date() if now_dt else None)
    start_dt = date.fromisoformat(clean_date(start_date, "start_date", around=around))
    end_dt = date.fromisoformat(clean_date(end_date, "end_date", around=around))
    if end_dt < start_dt:
        raise ValueError("End date must be on or after start date")
    if (end_dt - start_dt).days > 90:
        raise ValueError("Vacation pause range cannot exceed 90 days")

    sub = conn.execute(
        "SELECT * FROM subscriptions WHERE customer_id = ? AND is_active = 1",
        (customer_id,),
    ).fetchone()
    if not sub:
        raise ValueError("No active subscription for customer")

    plan_meals = PLAN_MEALS[sub["plan_type"]]
    target_meals = [m for m in plan_meals if meal_scope in ("all", m)]
    if not target_meals:
        raise ValueError(f"Plan '{sub['plan_type']}' does not include '{meal_scope}'")

    now_iso = (now_dt or datetime.now()).isoformat(timespec="seconds")
    ref = reference_date or (now_dt.date() if now_dt else date.today())
    paused_count = 0
    skipped_locked = 0

    cursor = start_dt
    while cursor <= end_dt:
        day_str = cursor.isoformat()
        for meal in target_meals:
            if not bypass_cutoff:
                locked, _ = is_meal_locked(conn, day_str, meal, now_dt=now_dt)
                if locked:
                    skipped_locked += 1
                    continue

            existing = conn.execute(
                """
                SELECT status FROM meal_logs
                WHERE subscription_id = ? AND meal_date = ? AND meal_type = ?
                """,
                (sub["id"], day_str, meal),
            ).fetchone()
            if existing and existing["status"] == "delivered":
                continue

            conn.execute(
                """
                INSERT INTO meal_logs (customer_id, subscription_id, meal_date, meal_type, status, responded_at)
                VALUES (?, ?, ?, ?, 'paused', ?)
                ON CONFLICT(subscription_id, meal_date, meal_type)
                DO UPDATE SET status = 'paused', responded_at = excluded.responded_at
                """,
                (customer_id, sub["id"], day_str, meal, now_iso),
            )
            paused_count += 1
        cursor += timedelta(days=1)

    new_end = calculate_estimated_end_date(conn, sub["id"], reference_date=ref)
    conn.execute(
        "UPDATE subscriptions SET estimated_end_date = ? WHERE id = ?",
        (new_end, sub["id"]),
    )
    return {
        "paused_meals": paused_count,
        "skipped_locked": skipped_locked,
        "estimated_end_date": new_end,
    }


def resume_paused_range(
    conn: sqlite3.Connection,
    *,
    customer_id: int,
    start_date: str,
    end_date: str,
    now_dt: datetime | None = None,
    bypass_cutoff: bool = False,
    reference_date: date | None = None,
) -> dict[str, Any]:
    """Resume previously paused meals in a date range back to pending."""
    around = reference_date or (now_dt.date() if now_dt else None)
    start_dt = date.fromisoformat(clean_date(start_date, "start_date", around=around))
    end_dt = date.fromisoformat(clean_date(end_date, "end_date", around=around))
    if end_dt < start_dt:
        raise ValueError("End date must be on or after start date")
    if (end_dt - start_dt).days > 366:
        raise ValueError("Resume range cannot exceed one year")

    sub = conn.execute(
        "SELECT * FROM subscriptions WHERE customer_id = ? AND is_active = 1",
        (customer_id,),
    ).fetchone()
    if not sub:
        raise ValueError("No active subscription for customer")

    rows = conn.execute(
        """
        SELECT id, meal_date, meal_type FROM meal_logs
        WHERE subscription_id = ? AND status = 'paused' AND meal_date BETWEEN ? AND ?
        """,
        (sub["id"], start_date, end_date),
    ).fetchall()

    resumed_count = 0
    for r in rows:
        if not bypass_cutoff:
            locked, _ = is_meal_locked(conn, r["meal_date"], r["meal_type"], now_dt=now_dt)
            if locked:
                continue
        conn.execute("DELETE FROM meal_logs WHERE id = ?", (r["id"],))
        resumed_count += 1

    ref = reference_date or (now_dt.date() if now_dt else date.today())
    new_end = calculate_estimated_end_date(conn, sub["id"], reference_date=ref)
    conn.execute(
        "UPDATE subscriptions SET estimated_end_date = ? WHERE id = ?",
        (new_end, sub["id"]),
    )
    return {"resumed_meals": resumed_count, "estimated_end_date": new_end}


def record_qr_delivery(
    conn: sqlite3.Connection,
    *,
    customer_id: int,
    meal_date: str,
    meal_type: str,
    qr_token: str,
    require_valid_qr: bool = True,
    box_returned: bool = False,
    delivered_timestamp: str | None = None,
    reference_date: date | None = None,
) -> dict[str, Any]:
    """Verify QR scan and record exact delivery timestamp, deducting 1 diet and updating box count."""
    _check_meal_type(meal_type)
    meal_date = clean_date(meal_date, "meal_date", around=reference_date)
    if not isinstance(qr_token, str) or len(qr_token) > LIMITS["qr"]:
        raise ValueError("Invalid QR code scanned. Please scan the provider's tiffin QR.")

    expected_qr = get_provider_qr_code(conn)
    if require_valid_qr and not hmac.compare_digest(
        qr_token.strip().encode("utf-8"), expected_qr.encode("utf-8")
    ):
        raise ValueError("Invalid QR code scanned. Please scan the provider's tiffin QR.")

    sub = conn.execute(
        "SELECT * FROM subscriptions WHERE customer_id = ? AND is_active = 1",
        (customer_id,),
    ).fetchone()
    if not sub:
        raise ValueError("No active subscription for customer")
    if meal_type not in PLAN_MEALS[sub["plan_type"]]:
        raise ValueError(f"Plan '{sub['plan_type']}' does not include '{meal_type}'")

    remaining = sub["total_diets"] - sub["diets_consumed"]
    if remaining <= 0:
        raise ValueError("No diets remaining on active plan. Please renew.")

    holidays = conn.execute(
        "SELECT holiday_date, meal_scope FROM holidays WHERE holiday_date = ?",
        (meal_date,),
    ).fetchall()
    if _holiday_covers_meal(holidays, meal_date, meal_type):
        raise ValueError(f"{meal_date} ({meal_type}) is marked as a provider holiday")

    existing = conn.execute(
        """
        SELECT * FROM meal_logs
        WHERE subscription_id = ? AND meal_date = ? AND meal_type = ?
        """,
        (sub["id"], meal_date, meal_type),
    ).fetchone()
    if existing and existing["status"] == "delivered":
        raise ValueError(
            f"{meal_type.title()} on {meal_date} already scanned at {existing['delivered_at']}"
        )

    ts = delivered_timestamp or datetime.now().isoformat(timespec="seconds")
    conn.execute(
        """
        INSERT INTO meal_logs (
            customer_id, subscription_id, meal_date, meal_type,
            status, responded_at, delivered_at, qr_token
        ) VALUES (?, ?, ?, ?, 'delivered', ?, ?, ?)
        ON CONFLICT(subscription_id, meal_date, meal_type)
        DO UPDATE SET
            status = 'delivered',
            delivered_at = excluded.delivered_at,
            qr_token = excluded.qr_token
        """,
        (customer_id, sub["id"], meal_date, meal_type, ts, ts, qr_token.strip()),
    )

    new_consumed = sub["diets_consumed"] + 1
    conn.execute(
        "UPDATE subscriptions SET diets_consumed = ? WHERE id = ?",
        (new_consumed, sub["id"]),
    )

    # Handing over 1 tiffin box increases boxes held by 1; returning an empty box offsets it.
    box_delta = 0 if box_returned else 1
    boxes_held = adjust_customer_boxes(conn, customer_id, box_delta)

    new_end = calculate_estimated_end_date(conn, sub["id"], reference_date=reference_date)
    conn.execute(
        "UPDATE subscriptions SET estimated_end_date = ? WHERE id = ?",
        (new_end, sub["id"]),
    )

    return {
        "status": "delivered",
        "delivered_at": ts,
        "diets_consumed": new_consumed,
        "diets_remaining": sub["total_diets"] - new_consumed,
        "boxes_with_customer": boxes_held,
        "estimated_end_date": new_end,
    }


def add_holiday(
    conn: sqlite3.Connection,
    *,
    holiday_date: str,
    meal_scope: str,
    reason: str = "",
    reference_date: date | None = None,
) -> dict[str, Any]:
    """Declare a provider holiday and extend all affected subscriptions."""
    if meal_scope not in ("full_day", "lunch", "dinner"):
        raise ValueError("meal_scope must be 'full_day', 'lunch', or 'dinner'")
    holiday_date = clean_date(holiday_date, "holiday_date", around=reference_date)
    reason = clean_text(reason, "Reason", max_len=LIMITS["reason"], required=False)

    now_iso = datetime.now().isoformat(timespec="seconds")
    conn.execute(
        """
        INSERT INTO holidays (holiday_date, meal_scope, reason, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(holiday_date, meal_scope)
        DO UPDATE SET reason = excluded.reason
        """,
        (holiday_date, meal_scope, reason, now_iso),
    )
    recalculate_all_end_dates(conn, reference_date=reference_date)
    return {"holiday_date": holiday_date, "meal_scope": meal_scope, "reason": reason}


def remove_holiday(
    conn: sqlite3.Connection,
    holiday_id: int,
    reference_date: date | None = None,
) -> None:
    """Remove a declared holiday and recalculate subscription end dates."""
    conn.execute("DELETE FROM holidays WHERE id = ?", (holiday_id,))
    recalculate_all_end_dates(conn, reference_date=reference_date)


def get_delivery_queue(
    conn: sqlite3.Connection,
    target_date: str,
    meal_type: str,
    now_dt: datetime | None = None,
) -> dict[str, Any]:
    """Return the provider's delivery queue (with route grouping) for a date and meal."""
    if meal_type not in ("lunch", "dinner"):
        raise ValueError("meal_type must be 'lunch' or 'dinner'")

    holidays = conn.execute(
        "SELECT holiday_date, meal_scope, reason FROM holidays WHERE holiday_date = ?",
        (target_date,),
    ).fetchall()
    is_holiday = _holiday_covers_meal(holidays, target_date, meal_type)
    holiday_reason = next(
        (h["reason"] for h in holidays if h["meal_scope"] in ("full_day", meal_type)),
        "",
    )
    locked, lock_reason = is_meal_locked(conn, target_date, meal_type, now_dt=now_dt)

    subs = conn.execute(
        """
        SELECT
            c.id AS customer_id,
            c.name,
            c.phone,
            c.address,
            c.route_area,
            c.boxes_with_customer,
            s.id AS subscription_id,
            s.plan_type,
            s.total_diets,
            s.diets_consumed,
            s.start_date,
            s.estimated_end_date
        FROM subscriptions s
        JOIN customers c ON c.id = s.customer_id
        WHERE s.is_active = 1 AND c.active = 1
        ORDER BY c.route_area ASC, c.name ASC
        """
    ).fetchall()

    logs = conn.execute(
        """
        SELECT subscription_id, status, delivered_at, responded_at
        FROM meal_logs
        WHERE meal_date = ? AND meal_type = ?
        """,
        (target_date, meal_type),
    ).fetchall()
    log_by_sub = {r["subscription_id"]: r for r in logs}

    items: list[dict[str, Any]] = []
    counts = {
        "total_eligible": 0,
        "confirmed": 0,
        "pending": 0,
        "cancelled": 0,
        "paused": 0,
        "delivered": 0,
        "left_to_deliver": 0,
    }
    routes_map: dict[str, dict[str, Any]] = {}

    for s in subs:
        if meal_type not in PLAN_MEALS[s["plan_type"]]:
            continue
        if s["start_date"] > target_date:
            continue

        remaining = s["total_diets"] - s["diets_consumed"]
        log = log_by_sub.get(s["subscription_id"])
        status = log["status"] if log else "pending"

        if remaining <= 0 and status != "delivered":
            continue

        counts["total_eligible"] += 1
        if is_holiday:
            effective_status = "holiday"
        else:
            effective_status = status
            counts[status] = counts.get(status, 0) + 1
            if status in ("pending", "confirmed"):
                counts["left_to_deliver"] += 1

        area = s["route_area"] or "General"
        item = {
            "customer_id": s["customer_id"],
            "subscription_id": s["subscription_id"],
            "name": s["name"],
            "phone": s["phone"],
            "address": s["address"],
            "route_area": area,
            "boxes_with_customer": s["boxes_with_customer"],
            "plan_type": s["plan_type"],
            "diets_remaining": remaining,
            "estimated_end_date": s["estimated_end_date"],
            "status": effective_status,
            "delivered_at": log["delivered_at"] if log else None,
            "responded_at": log["responded_at"] if log else None,
        }
        items.append(item)

        bucket = routes_map.setdefault(
            area,
            {"route_area": area, "left_to_deliver": 0, "total": 0, "items": []},
        )
        bucket["total"] += 1
        if effective_status in ("pending", "confirmed"):
            bucket["left_to_deliver"] += 1
        bucket["items"].append(item)

    return {
        "date": target_date,
        "meal_type": meal_type,
        "is_holiday": is_holiday,
        "holiday_reason": holiday_reason,
        "is_locked": locked,
        "lock_reason": lock_reason,
        "counts": counts,
        "items": items,
        "routes": list(routes_map.values()),
    }


def get_dashboard_data(
    conn: sqlite3.Connection,
    target_date: str | None = None,
    now_dt: datetime | None = None,
) -> dict[str, Any]:
    """Return full state needed by both Provider and Customer views."""
    current_dt = now_dt or datetime.now()
    ref_date = target_date or current_dt.date().isoformat()

    customers = [
        dict(r)
        for r in conn.execute(
            """
            SELECT
                c.id, c.name, c.phone, c.address, c.route_area, c.boxes_with_customer,
                s.id AS subscription_id, s.plan_type, s.total_diets,
                s.diets_consumed, (s.total_diets - s.diets_consumed) AS diets_remaining,
                s.amount_paid, s.payment_date, s.start_date, s.estimated_end_date
            FROM customers c
            LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.is_active = 1
            WHERE c.active = 1
            ORDER BY c.route_area ASC, c.name ASC
            """
        ).fetchall()
    ]

    holidays = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM holidays ORDER BY holiday_date DESC, id DESC"
        ).fetchall()
    ]

    payments = [
        dict(r)
        for r in conn.execute(
            """
            SELECT p.*, c.name AS customer_name
            FROM payments p
            JOIN customers c ON c.id = p.customer_id
            ORDER BY p.paid_at DESC, p.id DESC
            LIMIT 50
            """
        ).fetchall()
    ]

    recent_logs = [
        dict(r)
        for r in conn.execute(
            """
            SELECT m.*, c.name AS customer_name
            FROM meal_logs m
            JOIN customers c ON c.id = m.customer_id
            ORDER BY COALESCE(m.delivered_at, m.responded_at, m.meal_date) DESC, m.id DESC
            LIMIT 80
            """
        ).fetchall()
    ]

    lunch_queue = get_delivery_queue(conn, ref_date, "lunch", now_dt=current_dt)
    dinner_queue = get_delivery_queue(conn, ref_date, "dinner", now_dt=current_dt)
    expiring_soon = [c for c in customers if c["subscription_id"] and c["diets_remaining"] <= 3]
    total_boxes_out = sum(c["boxes_with_customer"] for c in customers)
    popup_prompt_row = conn.execute(
        "SELECT value FROM app_settings WHERE key = 'popup_broadcast'"
    ).fetchone()

    return {
        "today": ref_date,
        "current_time": current_dt.strftime("%H:%M"),
        "cutoffs": get_cutoff_settings(conn),
        "menus": get_daily_menus(conn, ref_date),
        "provider_qr_code": get_provider_qr_code(conn),
        "popup_broadcast": popup_prompt_row["value"] if popup_prompt_row else "",
        "total_boxes_out": total_boxes_out,
        "customers": customers,
        "holidays": holidays,
        "payments": payments,
        "recent_logs": recent_logs,
        "lunch_queue": lunch_queue,
        "dinner_queue": dinner_queue,
        "expiring_soon": expiring_soon,
    }


_EXPO_TOKEN_RE = re.compile(r"^Expo(?:nent)?PushToken\[[A-Za-z0-9_\-]+\]$")
DEFAULT_PROVIDER_PIN = "0000"


def set_customer_push_token(
    conn: sqlite3.Connection,
    customer_id: int,
    token: str | None,
) -> dict[str, Any]:
    """Store (or clear, with an empty token) the Expo push token for a customer."""
    row = conn.execute(
        "SELECT id FROM customers WHERE id = ? AND active = 1", (customer_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"Customer {customer_id} not found")

    cleaned = (token or "").strip()
    if cleaned and not _EXPO_TOKEN_RE.match(cleaned):
        raise ValueError("Invalid Expo push token (expected ExponentPushToken[...])")

    now_iso = datetime.now().isoformat(timespec="seconds")
    # A device token belongs to one phone; detach it from any other customer first.
    if cleaned:
        conn.execute(
            "UPDATE customers SET expo_push_token = NULL WHERE expo_push_token = ? AND id != ?",
            (cleaned, customer_id),
        )
    conn.execute(
        "UPDATE customers SET expo_push_token = ?, push_token_updated_at = ? WHERE id = ?",
        (cleaned or None, now_iso, customer_id),
    )
    return {"customer_id": customer_id, "expo_push_token": cleaned or None}


def clear_push_tokens(conn: sqlite3.Connection, tokens: list[str]) -> int:
    """Remove tokens Expo reported as no longer registered. Returns rows cleared."""
    cleared = 0
    for tok in tokens:
        cur = conn.execute(
            "UPDATE customers SET expo_push_token = NULL WHERE expo_push_token = ?", (tok,)
        )
        cleared += cur.rowcount
    return cleared


def build_meal_prompt_messages(
    conn: sqlite3.Connection,
    *,
    meal_type: str,
    meal_date: str | None = None,
    now_dt: datetime | None = None,
) -> list[dict[str, Any]]:
    """Build Expo push messages asking eligible customers to confirm today's meal.

    Raises ValueError if the cutoff has passed, the day is a holiday, or no menu is published.
    """
    _check_meal_type(meal_type)
    current = now_dt or datetime.now()
    target = clean_date(meal_date, "meal_date", around=current.date()) if meal_date else current.date().isoformat()

    locked, reason = is_meal_locked(conn, target, meal_type, now_dt=current)
    if locked:
        raise ValueError(f"Cannot send prompt: {reason}")

    holidays = conn.execute(
        "SELECT holiday_date, meal_scope FROM holidays WHERE holiday_date = ?", (target,)
    ).fetchall()
    if _holiday_covers_meal(holidays, target, meal_type):
        raise ValueError(f"{target} ({meal_type}) is a provider holiday; no prompt sent")

    menu = get_daily_menus(conn, target)[meal_type]
    if not menu:
        raise ValueError(f"Publish the {meal_type} menu for {target} before sending the prompt")

    cutoff = get_cutoff_settings(conn)[meal_type]
    rows = conn.execute(
        """
        SELECT c.id AS customer_id, c.name, c.expo_push_token, s.id AS subscription_id,
               s.plan_type, s.start_date, (s.total_diets - s.diets_consumed) AS remaining
        FROM customers c
        JOIN subscriptions s ON s.customer_id = c.id AND s.is_active = 1
        WHERE c.active = 1 AND c.expo_push_token IS NOT NULL AND c.expo_push_token != ''
        """
    ).fetchall()
    logs = {
        r["subscription_id"]: r["status"]
        for r in conn.execute(
            "SELECT subscription_id, status FROM meal_logs WHERE meal_date = ? AND meal_type = ?",
            (target, meal_type),
        ).fetchall()
    }

    label = meal_type.title()
    messages: list[dict[str, Any]] = []
    for r in rows:
        if meal_type not in PLAN_MEALS[r["plan_type"]]:
            continue
        if r["start_date"] > target or r["remaining"] <= 0:
            continue
        if logs.get(r["subscription_id"]) in ("paused", "delivered"):
            continue
        first_name = (r["name"] or "").split(" ")[0] or "there"
        messages.append(
            {
                "to": r["expo_push_token"],
                "title": f"{label} today, {first_name}?",
                "body": f"Menu: {menu}. Confirm or cancel before {cutoff}.",
                "sound": "default",
                "channelId": "meal-prompts",
                "priority": "high",
                "data": {
                    "type": "meal_prompt",
                    "meal_type": meal_type,
                    "meal_date": target,
                    "menu": menu,
                    "cutoff": cutoff,
                    "customer_id": r["customer_id"],
                },
            }
        )
    return messages


def _saved_provider_pin_hash(conn: sqlite3.Connection) -> str | None:
    row = conn.execute("SELECT value FROM app_settings WHERE key = 'provider_pin'").fetchone()
    return row["value"] if row and row["value"] else None


def verify_provider_pin(conn: sqlite3.Connection, pin: str) -> bool:
    """Check the provider PIN: the saved (hashed) PIN wins, else PROVIDER_PIN env, else the default."""
    saved = _saved_provider_pin_hash(conn)
    if saved:
        return verify_pin(pin, saved)
    expected = os.environ.get("PROVIDER_PIN", "").strip() or DEFAULT_PROVIDER_PIN
    return hmac.compare_digest(str(pin).strip().encode("utf-8"), expected.encode("utf-8"))


def provider_pin_is_default(conn: sqlite3.Connection) -> bool:
    """True when the provider would sign in with the publicly known default PIN."""
    return verify_provider_pin(conn, DEFAULT_PROVIDER_PIN)


def set_provider_pin(conn: sqlite3.Connection, current_pin: str, new_pin: str) -> None:
    if not verify_provider_pin(conn, current_pin):
        raise ValueError("Current provider PIN is incorrect")
    cleaned = str(new_pin).strip()
    if not _PROVIDER_PIN_RE.fullmatch(cleaned):
        raise ValueError("Provider PIN must be 4-8 digits")
    if cleaned == DEFAULT_PROVIDER_PIN:
        raise ValueError("Choose a PIN other than the default")
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('provider_pin', ?)",
        (hash_pin(cleaned),),
    )


# Demo accounts created by seed_demo_data(). Only exposed when the server runs with DEMO_MODE=1.
DEMO_CUSTOMER_PINS = {"9876543210": "1111", "9876501234": "2222", "9811122233": "3333"}


def get_demo_accounts(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        f"""
        SELECT c.id, c.name, c.phone, c.route_area, s.plan_type
        FROM customers c
        LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.is_active = 1
        WHERE c.active = 1 AND c.phone IN ({",".join("?" * len(DEMO_CUSTOMER_PINS))})
        ORDER BY c.route_area, c.name
        """,
        tuple(DEMO_CUSTOMER_PINS),
    ).fetchall()
    return [{**dict(r), "pin": DEMO_CUSTOMER_PINS[r["phone"]]} for r in rows]


def get_customer_summary(
    conn: sqlite3.Connection,
    customer_id: int,
    now_dt: datetime | None = None,
) -> dict[str, Any]:
    """Return everything the customer mobile app needs for one customer (no other customers' data)."""
    current = now_dt or datetime.now()
    today_str = current.date().isoformat()

    cust = conn.execute(
        """
        SELECT id, name, phone, address, route_area, boxes_with_customer,
               expo_push_token IS NOT NULL AS push_enabled
        FROM customers WHERE id = ? AND active = 1
        """,
        (customer_id,),
    ).fetchone()
    if cust is None:
        raise ValueError(f"Customer {customer_id} not found")

    sub = conn.execute(
        """
        SELECT id AS subscription_id, plan_type, total_diets, diets_consumed,
               (total_diets - diets_consumed) AS diets_remaining,
               amount_paid, payment_date, start_date, estimated_end_date
        FROM subscriptions WHERE customer_id = ? AND is_active = 1
        """,
        (customer_id,),
    ).fetchone()

    plan: dict[str, Any] | None = None
    today_meals: dict[str, Any] = {}
    if sub:
        plan = dict(sub)
        # Keep the auto-extending end date fresh relative to today.
        live_end = calculate_estimated_end_date(conn, sub["subscription_id"], reference_date=current.date())
        if live_end != sub["estimated_end_date"]:
            conn.execute(
                "UPDATE subscriptions SET estimated_end_date = ? WHERE id = ?",
                (live_end, sub["subscription_id"]),
            )
        plan["estimated_end_date"] = live_end

        holidays = conn.execute(
            "SELECT holiday_date, meal_scope, reason FROM holidays WHERE holiday_date = ?",
            (today_str,),
        ).fetchall()
        for meal in PLAN_MEALS[sub["plan_type"]]:
            log = conn.execute(
                """
                SELECT status, responded_at, delivered_at FROM meal_logs
                WHERE subscription_id = ? AND meal_date = ? AND meal_type = ?
                """,
                (sub["subscription_id"], today_str, meal),
            ).fetchone()
            locked, lock_reason = is_meal_locked(conn, today_str, meal, now_dt=current)
            is_holiday = _holiday_covers_meal(holidays, today_str, meal)
            today_meals[meal] = {
                "status": "holiday" if is_holiday else (log["status"] if log else "pending"),
                "responded_at": log["responded_at"] if log else None,
                "delivered_at": log["delivered_at"] if log else None,
                "is_locked": locked,
                "lock_reason": lock_reason,
                "is_holiday": is_holiday,
            }

    history = [
        dict(r)
        for r in conn.execute(
            """
            SELECT id, meal_date, meal_type, status, responded_at, delivered_at,
                   COALESCE(qr_token = 'MANUAL-PROVIDER-MARK', 0) AS marked_by_provider
            FROM meal_logs
            WHERE customer_id = ? AND status IN ('delivered', 'paused', 'cancelled', 'confirmed')
            ORDER BY meal_date DESC, COALESCE(delivered_at, responded_at) DESC, id DESC
            LIMIT 120
            """,
            (customer_id,),
        ).fetchall()
    ]
    payments = [
        dict(r)
        for r in conn.execute(
            """
            SELECT amount, diets_added, plan_type, paid_at, notes FROM payments
            WHERE customer_id = ? ORDER BY paid_at DESC, id DESC LIMIT 20
            """,
            (customer_id,),
        ).fetchall()
    ]
    upcoming_holidays = [
        dict(r)
        for r in conn.execute(
            "SELECT holiday_date, meal_scope, reason FROM holidays WHERE holiday_date >= ? ORDER BY holiday_date",
            (today_str,),
        ).fetchall()
    ]
    broadcast = conn.execute(
        "SELECT value FROM app_settings WHERE key = 'popup_broadcast'"
    ).fetchone()

    for row in history:
        row["marked_by_provider"] = bool(row["marked_by_provider"])
    out_cust = dict(cust)
    out_cust["push_enabled"] = bool(out_cust["push_enabled"])
    return {
        "today": today_str,
        "current_time": current.strftime("%H:%M"),
        "customer": out_cust,
        "plan": plan,
        "menus": get_daily_menus(conn, today_str),
        "cutoffs": get_cutoff_settings(conn),
        "today_meals": today_meals,
        "history": history,
        "payments": payments,
        "upcoming_holidays": upcoming_holidays,
        "popup_broadcast": broadcast["value"] if broadcast else "",
    }


def seed_demo_data(db_path: Path | str | None = None) -> None:
    """Populate realistic sample customers, menus, and deliveries if empty."""
    init_db(db_path)
    with get_connection(db_path) as conn:
        today = date.today()
        today_str = today.isoformat()

        menus = get_daily_menus(conn, today_str)
        if not menus["lunch"]:
            set_daily_menu(
                conn,
                menu_date=today_str,
                meal_type="lunch",
                items_text="Dal Tadka, Jeera Rice, 4 Tawa Roti, Aloo Gobi, Salad",
            )
        if not menus["dinner"]:
            set_daily_menu(
                conn,
                menu_date=today_str,
                meal_type="dinner",
                items_text="Paneer Butter Masala, 4 Phulka, Steamed Rice, Boondi Raita",
            )

        existing = conn.execute("SELECT COUNT(*) AS cnt FROM customers").fetchone()
        if existing and existing["cnt"] > 0:
            return

        get_provider_qr_code(conn)
        start_5_days_ago = (today - timedelta(days=5)).isoformat()
        start_2_days_ago = (today - timedelta(days=2)).isoformat()

        r1 = create_customer_with_subscription(
            conn,
            name="Aarav Sharma",
            phone="9876543210",
            address="Flat 302, Green Park Residency",
            route_area="Green Park",
            plan_type="both",
            total_diets=30,
            amount_paid=2400,
            start_date=start_5_days_ago,
            payment_date=start_5_days_ago,
            pin="1111",
            reference_date=today,
        )
        r2 = create_customer_with_subscription(
            conn,
            name="Priya Verma",
            phone="9876501234",
            address="B-14, Sector 18",
            route_area="Sector 18",
            plan_type="lunch_only",
            total_diets=15,
            amount_paid=1200,
            start_date=start_2_days_ago,
            payment_date=start_2_days_ago,
            pin="2222",
            reference_date=today,
        )
        create_customer_with_subscription(
            conn,
            name="Rohan Mehta",
            phone="9811122233",
            address="PG Room 8, Shanti Nagar",
            route_area="Green Park",
            plan_type="dinner_only",
            total_diets=4,
            amount_paid=360,
            start_date=start_2_days_ago,
            payment_date=start_2_days_ago,
            pin="3333",
            reference_date=today,
        )

        yesterday = (today - timedelta(days=1)).isoformat()
        record_qr_delivery(
            conn,
            customer_id=r1["customer_id"],
            meal_date=yesterday,
            meal_type="lunch",
            qr_token=get_provider_qr_code(conn),
            delivered_timestamp=f"{yesterday}T12:48:12",
            reference_date=today,
        )
        record_qr_delivery(
            conn,
            customer_id=r1["customer_id"],
            meal_date=yesterday,
            meal_type="dinner",
            qr_token=get_provider_qr_code(conn),
            box_returned=True,
            delivered_timestamp=f"{yesterday}T20:15:40",
            reference_date=today,
        )
        respond_to_meal(
            conn,
            customer_id=r2["customer_id"],
            meal_date=today_str,
            meal_type="lunch",
            wants_tiffin=True,
            bypass_cutoff=True,
            reference_date=today,
        )
