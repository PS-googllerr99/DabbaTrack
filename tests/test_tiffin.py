"""Automated tests for DabbaTrack core logic, QR SVG generation, and REST API."""

from __future__ import annotations

import io
import json
import sqlite3
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db
import push
import qr
import server


class _FakeSocket:
    """In-memory socket adapter for testing BaseHTTPRequestHandler without port binding."""

    def __init__(self, raw_request: bytes) -> None:
        self._rfile = io.BytesIO(raw_request)
        self.wfile_buf = io.BytesIO()

    def makefile(self, mode: str, *args, **kwargs):
        if "r" in mode:
            return self._rfile
        return self.wfile_buf

    def sendall(self, data: bytes) -> None:
        self.wfile_buf.write(data)

    def settimeout(self, _seconds: float | None) -> None:
        pass

    def close(self) -> None:
        pass


class TiffinCoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "test_tiffin.db"
        db.init_db(self.db_path)
        self.today = date(2026, 11, 11)
        self.morning = datetime(2026, 11, 11, 9, 0)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_end_date_extends_on_cancel_and_holiday_lunch_only(self) -> None:
        with db.get_connection(self.db_path) as conn:
            created = db.create_customer_with_subscription(
                conn,
                name="Test User",
                phone="9000000001",
                address="Addr 1",
                plan_type="lunch_only",
                total_diets=5,
                amount_paid=500,
                start_date="2026-11-11",
                reference_date=self.today,
            )
            self.assertEqual(created["estimated_end_date"], "2026-11-15")

            resp = db.respond_to_meal(
                conn,
                customer_id=created["customer_id"],
                meal_date="2026-11-12",
                meal_type="lunch",
                wants_tiffin=False,
                now_dt=self.morning,
                reference_date=self.today,
            )
            self.assertEqual(resp["estimated_end_date"], "2026-11-16")

            db.add_holiday(
                conn,
                holiday_date="2026-11-14",
                meal_scope="dinner",
                reason="Dinner off",
                reference_date=self.today,
            )
            sub = conn.execute(
                "SELECT estimated_end_date FROM subscriptions WHERE id = ?",
                (created["subscription_id"],),
            ).fetchone()
            self.assertEqual(sub["estimated_end_date"], "2026-11-16")

            db.add_holiday(
                conn,
                holiday_date="2026-11-14",
                meal_scope="full_day",
                reason="Festival",
                reference_date=self.today,
            )
            sub = conn.execute(
                "SELECT estimated_end_date FROM subscriptions WHERE id = ?",
                (created["subscription_id"],),
            ).fetchone()
            self.assertEqual(sub["estimated_end_date"], "2026-11-17")

    def test_both_plan_and_qr_delivery_timestamp_boxes_and_duplicate_guard(self) -> None:
        with db.get_connection(self.db_path) as conn:
            qr_code = db.get_provider_qr_code(conn)
            created = db.create_customer_with_subscription(
                conn,
                name="Both Plan User",
                phone="9000000002",
                address="Addr 2",
                route_area="Sector 18",
                plan_type="both",
                total_diets=4,
                amount_paid=400,
                start_date="2026-11-11",
                reference_date=self.today,
            )
            self.assertEqual(created["estimated_end_date"], "2026-11-12")

            res = db.respond_to_meal(
                conn,
                customer_id=created["customer_id"],
                meal_date="2026-11-11",
                meal_type="dinner",
                wants_tiffin=False,
                now_dt=self.morning,
                reference_date=self.today,
            )
            self.assertEqual(res["estimated_end_date"], "2026-11-13")

            with self.assertRaises(ValueError):
                db.record_qr_delivery(
                    conn,
                    customer_id=created["customer_id"],
                    meal_date="2026-11-11",
                    meal_type="lunch",
                    qr_token="WRONG-QR",
                    reference_date=self.today,
                )

            # Deliver lunch without returning an empty box -> boxes_with_customer = 1
            deliv = db.record_qr_delivery(
                conn,
                customer_id=created["customer_id"],
                meal_date="2026-11-11",
                meal_type="lunch",
                qr_token=qr_code,
                box_returned=False,
                delivered_timestamp="2026-11-11T12:34:56",
                reference_date=self.today,
            )
            self.assertEqual(deliv["delivered_at"], "2026-11-11T12:34:56")
            self.assertEqual(deliv["diets_consumed"], 1)
            self.assertEqual(deliv["diets_remaining"], 3)
            self.assertEqual(deliv["boxes_with_customer"], 1)
            self.assertEqual(deliv["estimated_end_date"], "2026-11-13")

            # Returning empty box drops count back to 0 (and clamps at 0)
            self.assertEqual(db.adjust_customer_boxes(conn, created["customer_id"], -1), 0)
            self.assertEqual(db.adjust_customer_boxes(conn, created["customer_id"], -1), 0)

            with self.assertRaises(ValueError):
                db.record_qr_delivery(
                    conn,
                    customer_id=created["customer_id"],
                    meal_date="2026-11-11",
                    meal_type="lunch",
                    qr_token=qr_code,
                    reference_date=self.today,
                )

    def test_cutoff_time_lock(self) -> None:
        with db.get_connection(self.db_path) as conn:
            db.set_cutoff_settings(conn, "10:00", "17:30")
            created = db.create_customer_with_subscription(
                conn,
                name="Cutoff User",
                phone="9000000099",
                address="Addr",
                plan_type="both",
                total_diets=6,
                amount_paid=600,
                start_date="2026-11-11",
                reference_date=self.today,
            )
            # 10:30 AM is after 10:00 lunch cutoff -> blocked
            late_morning = datetime(2026, 11, 11, 10, 30)
            with self.assertRaises(ValueError):
                db.respond_to_meal(
                    conn,
                    customer_id=created["customer_id"],
                    meal_date="2026-11-11",
                    meal_type="lunch",
                    wants_tiffin=False,
                    now_dt=late_morning,
                    reference_date=self.today,
                )
            # Dinner at 10:30 AM (before 17:30) -> allowed
            res = db.respond_to_meal(
                conn,
                customer_id=created["customer_id"],
                meal_date="2026-11-11",
                meal_type="dinner",
                wants_tiffin=False,
                now_dt=late_morning,
                reference_date=self.today,
            )
            self.assertEqual(res["status"], "cancelled")

    def test_pause_vacation_range_and_resume(self) -> None:
        with db.get_connection(self.db_path) as conn:
            created = db.create_customer_with_subscription(
                conn,
                name="Vacation User",
                phone="9000000088",
                address="Addr",
                plan_type="lunch_only",
                total_diets=5,
                amount_paid=500,
                start_date="2026-11-11",
                reference_date=self.today,
            )
            self.assertEqual(created["estimated_end_date"], "2026-11-15")

            # Pause Nov 12..Nov 14 (3 lunches) -> end date extends by 3 days to Nov 18
            paused = db.pause_date_range(
                conn,
                customer_id=created["customer_id"],
                start_date="2026-11-12",
                end_date="2026-11-14",
                meal_scope="all",
                now_dt=self.morning,
                reference_date=self.today,
            )
            self.assertEqual(paused["paused_meals"], 3)
            self.assertEqual(paused["estimated_end_date"], "2026-11-18")

            # Resume Nov 13..Nov 14 (2 lunches) -> end date shifts back to Nov 16
            resumed = db.resume_paused_range(
                conn,
                customer_id=created["customer_id"],
                start_date="2026-11-13",
                end_date="2026-11-14",
                now_dt=self.morning,
                reference_date=self.today,
            )
            self.assertEqual(resumed["resumed_meals"], 2)
            self.assertEqual(resumed["estimated_end_date"], "2026-11-16")

    def test_delivery_queue_route_grouping_and_menus(self) -> None:
        with db.get_connection(self.db_path) as conn:
            qr_code = db.get_provider_qr_code(conn)
            c1 = db.create_customer_with_subscription(
                conn,
                name="C1",
                phone="9000000011",
                address="A1",
                route_area="Green Park",
                plan_type="lunch_only",
                total_diets=10,
                amount_paid=800,
                start_date="2026-11-11",
                reference_date=self.today,
            )
            c2 = db.create_customer_with_subscription(
                conn,
                name="C2",
                phone="9000000012",
                address="A2",
                route_area="Sector 18",
                plan_type="both",
                total_diets=10,
                amount_paid=800,
                start_date="2026-11-11",
                reference_date=self.today,
            )
            c3 = db.create_customer_with_subscription(
                conn,
                name="C3",
                phone="9000000013",
                address="A3",
                route_area="Green Park",
                plan_type="dinner_only",
                total_diets=10,
                amount_paid=800,
                start_date="2026-11-11",
                reference_date=self.today,
            )
            db.record_qr_delivery(
                conn,
                customer_id=c1["customer_id"],
                meal_date="2026-11-11",
                meal_type="lunch",
                qr_token=qr_code,
                reference_date=self.today,
            )
            db.respond_to_meal(
                conn,
                customer_id=c2["customer_id"],
                meal_date="2026-11-11",
                meal_type="lunch",
                wants_tiffin=True,
                now_dt=self.morning,
                reference_date=self.today,
            )

            lunch_q = db.get_delivery_queue(conn, "2026-11-11", "lunch", now_dt=self.morning)
            self.assertEqual(lunch_q["counts"]["total_eligible"], 2)
            self.assertEqual(lunch_q["counts"]["delivered"], 1)
            self.assertEqual(lunch_q["counts"]["left_to_deliver"], 1)
            routes = {r["route_area"]: r for r in lunch_q["routes"]}
            self.assertEqual(routes["Green Park"]["left_to_deliver"], 0)
            self.assertEqual(routes["Sector 18"]["left_to_deliver"], 1)

            dinner_q = db.get_delivery_queue(conn, "2026-11-11", "dinner", now_dt=self.morning)
            self.assertEqual(dinner_q["counts"]["total_eligible"], 2)
            self.assertEqual(dinner_q["counts"]["left_to_deliver"], 2)
            self.assertNotEqual(c3["customer_id"], c1["customer_id"])

            db.set_daily_menu(
                conn,
                menu_date="2026-11-11",
                meal_type="lunch",
                items_text="Rajma Chawal, 4 Roti",
            )
            menus = db.get_daily_menus(conn, "2026-11-11")
            self.assertEqual(menus["lunch"], "Rajma Chawal, 4 Roti")

    def test_legacy_db_migration(self) -> None:
        legacy_path = Path(self.tmp.name) / "legacy.db"
        raw = sqlite3.connect(str(legacy_path))
        raw.executescript(
            """
            CREATE TABLE customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL UNIQUE,
                address TEXT NOT NULL,
                pin TEXT NOT NULL DEFAULT '1234',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                plan_type TEXT NOT NULL,
                total_diets INTEGER NOT NULL,
                diets_consumed INTEGER NOT NULL DEFAULT 0,
                amount_paid REAL NOT NULL DEFAULT 0,
                payment_date TEXT NOT NULL,
                start_date TEXT NOT NULL,
                estimated_end_date TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE meal_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                subscription_id INTEGER NOT NULL,
                meal_date TEXT NOT NULL,
                meal_type TEXT NOT NULL CHECK (meal_type IN ('lunch', 'dinner')),
                status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'delivered')),
                responded_at TEXT,
                delivered_at TEXT,
                qr_token TEXT,
                UNIQUE(subscription_id, meal_date, meal_type)
            );
            INSERT INTO customers (name, phone, address, pin, created_at)
            VALUES ('Legacy', '9999999999', 'Old St', '4321', '2026-11-01T00:00:00');
            INSERT INTO subscriptions (customer_id, plan_type, total_diets, amount_paid, payment_date, start_date, estimated_end_date, created_at)
            VALUES (1, 'lunch_only', 5, 500, '2026-11-11', '2026-11-11', '2026-11-15', '2026-11-11T00:00:00');
            """
        )
        raw.commit()
        raw.close()

        db.init_db(legacy_path)
        with db.get_connection(legacy_path) as conn:
            res = db.pause_date_range(
                conn,
                customer_id=1,
                start_date="2026-11-12",
                end_date="2026-11-12",
                bypass_cutoff=True,
                reference_date=self.today,
            )
            self.assertEqual(res["paused_meals"], 1)
            self.assertEqual(res["estimated_end_date"], "2026-11-16")

    def test_qr_svg_generation(self) -> None:
        svg_v1 = qr.render_qr_svg("TIFFIN-DABBA-01")
        self.assertIn("<svg", svg_v1)
        self.assertIn("</svg>", svg_v1)
        svg_v2 = qr.render_qr_svg("TIFFIN-20261111-123456")
        self.assertIn("<svg", svg_v2)


class HttpApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.orig_db_path = db.DB_PATH
        db.DB_PATH = Path(self.tmp.name) / "api_test.db"
        db.seed_demo_data(db.DB_PATH)
        server.LOGIN_LIMITER.reset()

    def tearDown(self) -> None:
        db.DB_PATH = self.orig_db_path
        self.tmp.cleanup()

    def _call(self, method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, bytes]:
        payload = json.dumps(body).encode("utf-8") if body is not None else b""
        headers = f"{method} {path} HTTP/1.1\r\nHost: localhost\r\n"
        if token:
            headers += f"Authorization: Bearer {token}\r\n"
        if body is not None:
            headers += f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n"
        raw_req = (headers + "\r\n").encode("utf-8") + payload
        sock = _FakeSocket(raw_req)
        server.TiffinHandler(sock, ("127.0.0.1", 0), None)
        raw_resp = sock.wfile_buf.getvalue()
        head, _, resp_body = raw_resp.partition(b"\r\n\r\n")
        status_line = head.splitlines()[0].decode("utf-8")
        status_code = int(status_line.split()[1])
        return status_code, resp_body

    def test_dashboard_login_menu_pause_and_scan_endpoints(self) -> None:
        status, body = self._call("POST", "/api/provider/login", {"pin": db.DEFAULT_PROVIDER_PIN})
        self.assertEqual(status, 200)
        ptoken = json.loads(body)["token"]

        status, body = self._call("GET", "/api/dashboard", token=ptoken)
        self.assertEqual(status, 200)
        dash = json.loads(body.decode("utf-8"))
        self.assertGreaterEqual(len(dash["customers"]), 3)
        self.assertIn("lunch", dash["menus"])
        self.assertIn("lunch", dash["cutoffs"])
        qr_code = dash["provider_qr_code"]

        # Customer PIN login
        first = dash["customers"][0]
        status, _ = self._call("POST", "/api/customer/login", {"phone": first["phone"], "pin": "0000"})
        self.assertEqual(status, 401)
        status, login_body = self._call(
            "POST", "/api/customer/login", {"phone": first["phone"], "pin": db.DEMO_CUSTOMER_PINS[first["phone"]]}
        )
        self.assertEqual(status, 200)
        login = json.loads(login_body.decode("utf-8"))
        self.assertEqual(login["customer"]["id"], first["id"])
        ctoken = login["token"]

        # Publish menu
        status, menu_body = self._call(
            "POST",
            "/api/menus",
            {"menu_date": dash["today"], "meal_type": "lunch", "items_text": "Kadhi Pakora, Rice"},
            token=ptoken,
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(menu_body.decode("utf-8"))["items_text"], "Kadhi Pakora, Rice")

        # Scan QR
        status, body = self._call(
            "POST",
            "/api/meals/scan-qr",
            {
                "customer_id": first["id"],
                "meal_date": dash["today"],
                "meal_type": "lunch",
                "qr_token": qr_code,
                "box_returned": False,
            },
            token=ctoken,
        )
        self.assertEqual(status, 200)
        scan_res = json.loads(body.decode("utf-8"))
        self.assertEqual(scan_res["status"], "delivered")
        self.assertTrue(scan_res["delivered_at"])

        status, svg_bytes = self._call("GET", "/api/qr.svg", token=ptoken)
        self.assertEqual(status, 200)
        self.assertIn("<svg", svg_bytes.decode("utf-8"))


def _http_call(
    method: str, path: str, body: Any = None, token: str | None = None, raw: bytes | None = None
) -> tuple[int, dict[str, str], bytes]:
    """Drive TiffinHandler in-memory and return (status, headers, body)."""
    payload = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else b"")
    headers = f"{method} {path} HTTP/1.1\r\nHost: localhost\r\n"
    if token:
        headers += f"Authorization: Bearer {token}\r\n"
    if body is not None or raw is not None:
        headers += f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n"
    sock = _FakeSocket((headers + "\r\n").encode("utf-8") + payload)
    server.TiffinHandler(sock, ("127.0.0.1", 0), None)
    head, _, resp_body = sock.wfile_buf.getvalue().partition(b"\r\n\r\n")
    lines = head.decode("utf-8").splitlines()
    status_code = int(lines[0].split()[1])
    resp_headers = {}
    for line in lines[1:]:
        key, _, value = line.partition(":")
        resp_headers[key.strip().lower()] = value.strip()
    return status_code, resp_headers, resp_body


VALID_TOKEN = "ExponentPushToken[abc123XYZ_-]"


def _provider_token() -> str:
    status, _, raw = _http_call("POST", "/api/provider/login", {"pin": db.DEFAULT_PROVIDER_PIN})
    assert status == 200, raw
    return json.loads(raw)["token"]


def _customer_token(phone: str) -> tuple[int, str]:
    status, _, raw = _http_call(
        "POST", "/api/customer/login", {"phone": phone, "pin": db.DEMO_CUSTOMER_PINS[phone]}
    )
    assert status == 200, raw
    data = json.loads(raw)
    return data["customer"]["id"], data["token"]


class PushAndPromptCoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "push.db"
        db.init_db(self.db_path)
        self.today = date(2026, 11, 11)
        self.morning = datetime(2026, 11, 11, 8, 30)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _customer(self, conn, phone: str, plan: str, token: str | None = VALID_TOKEN, diets: int = 10) -> int:
        cid = db.create_customer_with_subscription(
            conn,
            name=f"User {phone}",
            phone=phone,
            address="Addr",
            plan_type=plan,
            total_diets=diets,
            amount_paid=100,
            start_date="2026-11-11",
            reference_date=self.today,
        )["customer_id"]
        if token:
            db.set_customer_push_token(conn, cid, token)
        return cid

    def test_push_token_validation_and_reassignment(self) -> None:
        with db.get_connection(self.db_path) as conn:
            a = self._customer(conn, "9100000001", "both", token=None)
            b = self._customer(conn, "9100000002", "both", token=None)
            with self.assertRaises(ValueError):
                db.set_customer_push_token(conn, a, "not-a-token")
            with self.assertRaises(ValueError):
                db.set_customer_push_token(conn, 9999, VALID_TOKEN)

            db.set_customer_push_token(conn, a, VALID_TOKEN)
            # Same phone now logged in as another customer -> token moves.
            db.set_customer_push_token(conn, b, VALID_TOKEN)
            rows = conn.execute("SELECT id, expo_push_token FROM customers ORDER BY id").fetchall()
            self.assertIsNone(rows[0]["expo_push_token"])
            self.assertEqual(rows[1]["expo_push_token"], VALID_TOKEN)

            # Empty token clears (logout).
            db.set_customer_push_token(conn, b, "")
            row = conn.execute("SELECT expo_push_token FROM customers WHERE id = ?", (b,)).fetchone()
            self.assertIsNone(row["expo_push_token"])

    def test_meal_prompt_messages_filter_plan_pause_and_guards(self) -> None:
        with db.get_connection(self.db_path) as conn:
            lunch_user = self._customer(conn, "9100000011", "lunch_only", "ExponentPushToken[L1]")
            self._customer(conn, "9100000012", "dinner_only", "ExponentPushToken[D1]")
            paused_user = self._customer(conn, "9100000013", "both", "ExponentPushToken[P1]")
            self._customer(conn, "9100000014", "both", token=None)

            with self.assertRaises(ValueError):  # no menu published yet
                db.build_meal_prompt_messages(conn, meal_type="lunch", now_dt=self.morning)

            db.set_daily_menu(conn, menu_date="2026-11-11", meal_type="lunch", items_text="Rajma Chawal")
            db.pause_date_range(
                conn,
                customer_id=paused_user,
                start_date="2026-11-11",
                end_date="2026-11-11",
                now_dt=self.morning,
                reference_date=self.today,
            )
            msgs = db.build_meal_prompt_messages(conn, meal_type="lunch", now_dt=self.morning)
            self.assertEqual([m["to"] for m in msgs], ["ExponentPushToken[L1]"])
            self.assertEqual(msgs[0]["data"]["customer_id"], lunch_user)
            self.assertEqual(msgs[0]["data"]["meal_date"], "2026-11-11")
            self.assertIn("Rajma Chawal", msgs[0]["body"])

            with self.assertRaises(ValueError):  # past the 10:00 lunch cutoff
                db.build_meal_prompt_messages(
                    conn, meal_type="lunch", now_dt=datetime(2026, 11, 11, 10, 5)
                )

            db.add_holiday(
                conn, holiday_date="2026-11-11", meal_scope="lunch", reason="Off", reference_date=self.today
            )
            with self.assertRaises(ValueError):
                db.build_meal_prompt_messages(conn, meal_type="lunch", now_dt=self.morning)

    def test_customer_summary_is_scoped_and_has_history(self) -> None:
        with db.get_connection(self.db_path) as conn:
            qr_code = db.get_provider_qr_code(conn)
            me = self._customer(conn, "9100000021", "both", token=None)
            other = self._customer(conn, "9100000022", "both", token=None)
            db.record_qr_delivery(
                conn,
                customer_id=me,
                meal_date="2026-11-11",
                meal_type="lunch",
                qr_token=qr_code,
                delivered_timestamp="2026-11-11T12:40:00",
                reference_date=self.today,
            )
            db.respond_to_meal(
                conn,
                customer_id=other,
                meal_date="2026-11-11",
                meal_type="dinner",
                wants_tiffin=False,
                now_dt=self.morning,
                reference_date=self.today,
            )
            summary = db.get_customer_summary(conn, me, now_dt=datetime(2026, 11, 11, 13, 0))
            self.assertEqual(summary["customer"]["id"], me)
            self.assertNotIn("pin", summary["customer"])
            self.assertEqual(summary["plan"]["diets_remaining"], 9)
            self.assertEqual(summary["today_meals"]["lunch"]["status"], "delivered")
            self.assertTrue(summary["today_meals"]["lunch"]["is_locked"])
            self.assertFalse(summary["today_meals"]["dinner"]["is_locked"])
            self.assertEqual(len(summary["history"]), 1)
            self.assertEqual(summary["history"][0]["delivered_at"], "2026-11-11T12:40:00")

    def test_provider_pin(self) -> None:
        with db.get_connection(self.db_path) as conn:
            self.assertTrue(db.verify_provider_pin(conn, db.DEFAULT_PROVIDER_PIN))
            with self.assertRaises(ValueError):
                db.set_provider_pin(conn, "9999", "4321")
            with self.assertRaises(ValueError):
                db.set_provider_pin(conn, db.DEFAULT_PROVIDER_PIN, "12")
            db.set_provider_pin(conn, db.DEFAULT_PROVIDER_PIN, "4321")
            self.assertTrue(db.verify_provider_pin(conn, "4321"))
            self.assertFalse(db.verify_provider_pin(conn, db.DEFAULT_PROVIDER_PIN))

    def test_push_client_chunks_and_reports_invalid_tokens(self) -> None:
        calls: list[int] = []

        def fake_transport(url, body, headers):
            calls.append(len(body))
            data = []
            for msg in body:
                if msg["to"].endswith("[dead]"):
                    data.append({"status": "error", "details": {"error": "DeviceNotRegistered"}})
                else:
                    data.append({"status": "ok", "id": "ticket"})
            return {"data": data}

        messages = [{"to": f"ExponentPushToken[t{i}]"} for i in range(230)]
        messages.append({"to": "ExponentPushToken[dead]"})
        res = push.send_push_messages(messages, transport=fake_transport)
        self.assertEqual(calls, [100, 100, 31])
        self.assertEqual(res["sent"], 230)
        self.assertEqual(res["failed"], 1)
        self.assertEqual(res["invalid_tokens"], ["ExponentPushToken[dead]"])

    def test_due_auto_prompts_window(self) -> None:
        cutoffs = {"lunch": "10:00", "dinner": "17:30"}
        self.assertEqual(server.due_auto_prompts(datetime(2026, 11, 11, 8, 59), cutoffs, 60, {}), [])
        self.assertEqual(server.due_auto_prompts(datetime(2026, 11, 11, 9, 0), cutoffs, 60, {}), ["lunch"])
        self.assertEqual(
            server.due_auto_prompts(datetime(2026, 11, 11, 9, 30), cutoffs, 60, {"lunch": "2026-11-11"}), []
        )
        self.assertEqual(server.due_auto_prompts(datetime(2026, 11, 11, 10, 0), cutoffs, 60, {}), [])
        self.assertEqual(server.due_auto_prompts(datetime(2026, 11, 11, 17, 0), cutoffs, 60, {}), ["dinner"])


class MobileApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.orig_db_path = db.DB_PATH
        self.orig_transport = server.PUSH_TRANSPORT
        db.DB_PATH = Path(self.tmp.name) / "mobile_api.db"
        db.seed_demo_data(db.DB_PATH)
        self.sent_batches: list[list[dict]] = []

        def fake_transport(url, body, headers):
            self.sent_batches.append(body)
            data = []
            for msg in body:
                if msg["to"] == "ExponentPushToken[gone]":
                    data.append({"status": "error", "details": {"error": "DeviceNotRegistered"}})
                else:
                    data.append({"status": "ok", "id": "t"})
            return {"data": data}

        server.PUSH_TRANSPORT = fake_transport
        server.LOGIN_LIMITER.reset()
        self.tomorrow = (date.today() + timedelta(days=1)).isoformat()
        self.ptoken = _provider_token()

    def tearDown(self) -> None:
        db.DB_PATH = self.orig_db_path
        server.PUSH_TRANSPORT = self.orig_transport
        self.tmp.cleanup()

    def _json(self, method: str, path: str, body: dict | None = None, token: str | None = "provider") -> tuple[int, dict]:
        status, _, raw = _http_call(method, path, body, token=self.ptoken if token == "provider" else token)
        return status, json.loads(raw.decode("utf-8"))

    def _customers(self) -> list[dict]:
        return self._json("GET", "/api/dashboard")[1]["customers"]

    def test_cors_headers_and_preflight(self) -> None:
        status, headers, _ = _http_call("OPTIONS", "/api/meals/respond")
        self.assertEqual(status, 204)
        self.assertEqual(headers["access-control-allow-origin"], "*")
        self.assertIn("POST", headers["access-control-allow-methods"])
        self.assertIn("Content-Type", headers["access-control-allow-headers"])

        status, headers, _ = _http_call("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers["access-control-allow-origin"], "*")

        status, headers, _ = _http_call("POST", "/api/customer/login", {"phone": "x", "pin": "0"})
        self.assertEqual(status, 401)
        self.assertEqual(headers["access-control-allow-origin"], "*")

    def test_provider_login_endpoint(self) -> None:
        status, _ = self._json("POST", "/api/provider/login", {"pin": "nope"}, token=None)
        self.assertEqual(status, 401)
        status, body = self._json("POST", "/api/provider/login", {"pin": db.DEFAULT_PROVIDER_PIN}, token=None)
        self.assertEqual(status, 200)
        self.assertTrue(body["provider"])
        self.assertTrue(body["token"])

    def test_push_token_and_send_meal_prompt(self) -> None:
        custs = {c["plan_type"]: c for c in self._customers()}
        both, lunch_only, dinner_only = custs["both"], custs["lunch_only"], custs["dinner_only"]

        status, body = self._json(
            "POST", "/api/customers/push-token", {"customer_id": both["id"], "expo_push_token": "bad"}
        )
        self.assertEqual(status, 400)

        for cust, tok in (
            (both, "ExponentPushToken[both1]"),
            (lunch_only, "ExponentPushToken[gone]"),
            (dinner_only, "ExponentPushToken[din1]"),
        ):
            status, body = self._json(
                "POST", "/api/customers/push-token", {"customer_id": cust["id"], "expo_push_token": tok}
            )
            self.assertEqual(status, 200)
            self.assertEqual(body["expo_push_token"], tok)

        # No menu yet for tomorrow -> 400 and nothing sent.
        status, body = self._json(
            "POST", "/api/push/send-meal-prompt", {"meal_type": "lunch", "meal_date": self.tomorrow}
        )
        self.assertEqual(status, 400)
        self.assertIn("menu", body["error"])
        self.assertEqual(self.sent_batches, [])

        self._json(
            "POST",
            "/api/menus",
            {"menu_date": self.tomorrow, "meal_type": "lunch", "items_text": "Chole Bhature"},
        )

        status, body = self._json(
            "POST",
            "/api/push/send-meal-prompt",
            {"meal_type": "lunch", "meal_date": self.tomorrow, "dry_run": True},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["recipients"], 2)
        self.assertEqual(self.sent_batches, [])

        status, body = self._json(
            "POST", "/api/push/send-meal-prompt", {"meal_type": "lunch", "meal_date": self.tomorrow}
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["recipients"], 2)
        self.assertEqual(body["sent"], 1)
        self.assertEqual(body["invalid_tokens"], ["ExponentPushToken[gone]"])
        self.assertTrue(body["broadcast"].startswith("lunch|"))
        sent_to = sorted(m["to"] for m in self.sent_batches[0])
        self.assertEqual(sent_to, ["ExponentPushToken[both1]", "ExponentPushToken[gone]"])
        self.assertEqual(self.sent_batches[0][0]["data"]["type"], "meal_prompt")
        self.assertIn("Chole Bhature", self.sent_batches[0][0]["body"])

        # Dead token was cleared.
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT expo_push_token FROM customers WHERE id = ?", (lunch_only["id"],)
            ).fetchone()
        self.assertIsNone(row["expo_push_token"])

    def test_customer_summary_endpoint(self) -> None:
        first = self._customers()[0]
        status, body = self._json("GET", f"/api/customers/{first['id']}/summary")
        self.assertEqual(status, 200)
        self.assertEqual(body["customer"]["id"], first["id"])
        self.assertIn("lunch", body["menus"])
        self.assertIn("estimated_end_date", body["plan"])
        self.assertNotIn("customers", body)

        status, _ = self._json("GET", "/api/customers/99999/summary")
        self.assertEqual(status, 404)


class SecurityTests(unittest.TestCase):
    """Phase 1 hardening: authentication, authorization, PIN storage, rate limits, demo gating."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.orig_db_path = db.DB_PATH
        self.orig_demo = server.DEMO_MODE
        db.DB_PATH = Path(self.tmp.name) / "security.db"
        db.seed_demo_data(db.DB_PATH)
        server.LOGIN_LIMITER.reset()
        self.ptoken = _provider_token()
        phones = list(db.DEMO_CUSTOMER_PINS)
        self.cid, self.ctoken = _customer_token(phones[0])
        self.other_id, self.other_token = _customer_token(phones[1])

    def tearDown(self) -> None:
        db.DB_PATH = self.orig_db_path
        server.DEMO_MODE = self.orig_demo
        self.tmp.cleanup()

    def _status(self, method: str, path: str, body: Any = None, token: str | None = None) -> int:
        return _http_call(method, path, body, token=token)[0]

    def test_unauthenticated_requests_are_rejected(self) -> None:
        for method, path, body in [
            ("GET", "/api/dashboard", None),
            ("GET", "/api/qr.svg", None),
            ("GET", f"/api/customers/{self.cid}/summary", None),
            ("POST", "/api/qr/rotate", {}),
            ("POST", "/api/push/send-meal-prompt", {"meal_type": "lunch"}),
            ("POST", "/api/menus", {"meal_type": "lunch", "items_text": "x"}),
            ("POST", "/api/meals/respond", {"customer_id": self.cid, "meal_type": "lunch", "wants_tiffin": True}),
            ("POST", "/api/customers/push-token", {"customer_id": self.cid, "expo_push_token": VALID_TOKEN}),
            ("DELETE", "/api/holidays/1", None),
        ]:
            with self.subTest(path=path):
                self.assertEqual(self._status(method, path, body), 401)
                self.assertEqual(self._status(method, path, body, token="forged-token"), 401)

    def test_customer_cannot_use_provider_routes_or_other_customers(self) -> None:
        for method, path, body in [
            ("GET", "/api/dashboard", None),
            ("GET", "/api/qr.svg", None),
            ("POST", "/api/qr/rotate", {}),
            ("POST", "/api/meals/manual-deliver", {"customer_id": self.cid, "meal_type": "lunch"}),
            ("POST", f"/api/customers/{self.cid}/boxes", {"delta": -5}),
            ("POST", f"/api/customers/{self.cid}/reset-pin", {}),
            ("GET", f"/api/customers/{self.other_id}/summary", None),
            ("POST", "/api/meals/respond", {"customer_id": self.other_id, "meal_type": "lunch", "wants_tiffin": False}),
            ("POST", "/api/meals/pause", {"customer_id": self.other_id, "start_date": "2099-01-01", "end_date": "2099-01-02"}),
            ("POST", "/api/customers/push-token", {"customer_id": self.other_id, "expo_push_token": VALID_TOKEN}),
        ]:
            with self.subTest(path=path):
                self.assertEqual(self._status(method, path, body, token=self.ctoken), 403)
        self.assertEqual(self._status("GET", f"/api/customers/{self.cid}/summary", token=self.ctoken), 200)
        self.assertEqual(self._status("GET", f"/api/customers/{self.other_id}/summary", token=self.ptoken), 200)

    def test_pins_never_returned_and_stored_hashed(self) -> None:
        status, _, raw = _http_call("GET", "/api/dashboard", token=self.ptoken)
        self.assertEqual(status, 200)
        for cust in json.loads(raw)["customers"]:
            self.assertNotIn("pin", cust)
        status, _, raw = _http_call("GET", f"/api/customers/{self.cid}/summary", token=self.ctoken)
        summary = json.loads(raw)
        self.assertNotIn("pin", summary["customer"])
        for row in summary["history"]:
            self.assertNotIn("qr_token", row)
        with db.get_connection() as conn:
            pins = [r["pin"] for r in conn.execute("SELECT pin FROM customers")]
            db.set_provider_pin(conn, db.DEFAULT_PROVIDER_PIN, "582913")
            saved = conn.execute("SELECT value FROM app_settings WHERE key = 'provider_pin'").fetchone()["value"]
        self.assertTrue(all(p.startswith("scrypt$") for p in pins))
        self.assertTrue(saved.startswith("scrypt$"))
        self.assertNotIn("582913", saved)

    def test_bypass_cutoff_only_for_provider(self) -> None:
        with db.get_connection() as conn:
            db.set_cutoff_settings(conn, lunch_cutoff="00:00", dinner_cutoff="00:00")
        body = {"customer_id": self.cid, "meal_type": "dinner", "wants_tiffin": False, "bypass_cutoff": True}
        self.assertEqual(self._status("POST", "/api/meals/respond", body, token=self.ctoken), 400)
        self.assertEqual(self._status("POST", "/api/meals/respond", body, token=self.ptoken), 200)

    def test_login_rate_limit_locks_after_repeated_failures(self) -> None:
        phone = list(db.DEMO_CUSTOMER_PINS)[2]
        for _ in range(server.ACCOUNT_FAIL_LIMIT):
            self.assertEqual(self._status("POST", "/api/customer/login", {"phone": phone, "pin": "9999"}), 401)
        status, headers, raw = _http_call(
            "POST", "/api/customer/login", {"phone": phone, "pin": db.DEMO_CUSTOMER_PINS[phone]}
        )
        self.assertEqual(status, 429)
        self.assertGreater(int(headers["retry-after"]), 0)
        self.assertIn("Try again", json.loads(raw)["error"])

    def test_logout_and_pin_reset_revoke_sessions(self) -> None:
        self.assertEqual(self._status("POST", "/api/auth/logout", {}, token=self.other_token), 200)
        self.assertEqual(self._status("GET", f"/api/customers/{self.other_id}/summary", token=self.other_token), 401)

        status, _, raw = _http_call("POST", f"/api/customers/{self.cid}/reset-pin", {}, token=self.ptoken)
        self.assertEqual(status, 200)
        new_pin = json.loads(raw)["pin"]
        self.assertRegex(new_pin, r"^\d{4}$")
        self.assertEqual(self._status("GET", f"/api/customers/{self.cid}/summary", token=self.ctoken), 401)
        phone = list(db.DEMO_CUSTOMER_PINS)[0]
        self.assertEqual(self._status("POST", "/api/customer/login", {"phone": phone, "pin": new_pin}), 200)

        self.assertEqual(
            self._status("POST", f"/api/customers/{self.cid}/reset-pin", {"pin": "12"}, token=self.ptoken), 400
        )

    def test_expired_session_is_rejected(self) -> None:
        with db.get_connection() as conn:
            self.assertIsNotNone(db.get_session(conn, self.ctoken))
            later = datetime.now() + db.SESSION_TTL["customer"] + timedelta(minutes=1)
            self.assertIsNone(db.get_session(conn, self.ctoken, now_dt=later))

    def test_qr_codes_are_random_and_rotation_is_provider_only(self) -> None:
        with db.get_connection() as conn:
            code = db.get_provider_qr_code(conn)
        self.assertNotEqual(code, db.LEGACY_DEFAULT_QR)
        self.assertGreaterEqual(len(code), 20)
        qr.render_qr_svg(code)  # must still fit the encoder
        status, _, raw = _http_call("POST", "/api/qr/rotate", {}, token=self.ptoken)
        self.assertEqual(status, 200)
        self.assertNotEqual(json.loads(raw)["provider_qr_code"], code)

    def test_malformed_bodies_get_400_not_a_dropped_connection(self) -> None:
        for raw in (b"[1,2]", b"null", b"7"):
            with self.subTest(raw=raw):
                self.assertEqual(_http_call("POST", "/api/customer/login", raw=raw)[0], 400)

    def test_demo_endpoint_is_gated(self) -> None:
        server.DEMO_MODE = False
        status, _, raw = _http_call("GET", "/api/demo")
        self.assertEqual((status, json.loads(raw)), (200, {"enabled": False}))
        server.DEMO_MODE = True
        status, _, raw = _http_call("GET", "/api/demo")
        data = json.loads(raw)
        self.assertTrue(data["enabled"])
        self.assertEqual({c["phone"]: c["pin"] for c in data["customers"]}, db.DEMO_CUSTOMER_PINS)

    def test_startup_refuses_default_provider_pin_outside_demo(self) -> None:
        server.DEMO_MODE = False
        with mock.patch.dict("os.environ", {}, clear=False):
            os_env = __import__("os").environ
            os_env.pop("PROVIDER_PIN", None)
            with self.assertRaises(SystemExit):
                server.check_startup_security()
            os_env["PROVIDER_PIN"] = "0000"
            with self.assertRaises(SystemExit):
                server.check_startup_security()
            os_env["PROVIDER_PIN"] = "482913"
            server.check_startup_security()  # no error
        server.DEMO_MODE = True
        server.check_startup_security()

    def test_legacy_plaintext_pins_and_default_qr_are_migrated(self) -> None:
        path = Path(self.tmp.name) / "legacy.db"
        db.init_db(path)
        with db.get_connection(path) as conn:
            conn.execute(
                "INSERT INTO customers (name, phone, address, pin, created_at) VALUES ('A', '9000000001', 'x', '4321', '2026-01-01')"
            )
            conn.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('provider_pin', '7777')")
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('provider_qr_code', ?)", (db.LEGACY_DEFAULT_QR,)
            )
        db.init_db(path)
        with db.get_connection(path) as conn:
            self.assertIsNotNone(db.authenticate_customer(conn, "9000000001", "4321"))
            self.assertIsNone(db.authenticate_customer(conn, "9000000001", "1234"))
            self.assertTrue(db.verify_provider_pin(conn, "7777"))
            self.assertNotEqual(db.get_provider_qr_code(conn), db.LEGACY_DEFAULT_QR)
            stored = conn.execute("SELECT pin FROM customers").fetchone()["pin"]
        self.assertTrue(stored.startswith("scrypt$"))


def _raw_call(raw_request: bytes) -> tuple[int, dict[str, Any]]:
    """Send hand-built request bytes (for malformed headers) and return (status, json body)."""
    sock = _FakeSocket(raw_request)
    server.TiffinHandler(sock, ("127.0.0.1", 0), None)
    head, _, body = sock.wfile_buf.getvalue().partition(b"\r\n\r\n")
    status = int(head.splitlines()[0].split()[1])
    return status, json.loads(body) if body else {}


class StabilityTests(unittest.TestCase):
    """Phase 2: every bad request gets a JSON reply; failures are logged, not leaked."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.orig_db_path = db.DB_PATH
        self.orig_transport = server.PUSH_TRANSPORT
        db.DB_PATH = Path(self.tmp.name) / "stability.db"
        db.seed_demo_data(db.DB_PATH)
        server.LOGIN_LIMITER.reset()
        self.ptoken = _provider_token()

    def tearDown(self) -> None:
        db.DB_PATH = self.orig_db_path
        server.PUSH_TRANSPORT = self.orig_transport
        self.tmp.cleanup()

    def test_malformed_requests_get_json_errors(self) -> None:
        base = b"POST /api/customer/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
        cases = [
            (base + b"Content-Length: abc\r\n\r\n{}", 400),
            (base + b"Content-Length: -5\r\n\r\n", 400),
            (base + b"Content-Length: 2\r\n\r\n\xff\xfe", 400),
            (base + b"Content-Length: 3\r\n\r\n{x}", 400),
            (base + f"Content-Length: {server.MAX_BODY_BYTES + 1}\r\n\r\n".encode(), 413),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw[:90]):
                status, body = _raw_call(raw)
                self.assertEqual(status, expected)
                self.assertIn("error", body)

    def test_wrong_field_types_are_400(self) -> None:
        bad = {"name": 123, "phone": "9000000099", "address": "x", "plan_type": "both", "total_diets": 5}
        status, _, raw = _http_call("POST", "/api/customers", bad, token=self.ptoken)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw)["error"], "Name must be text")
        # Types the validators don't anticipate still fall back to a generic 400 (and a log line).
        with self.assertLogs("dabbatrack", level="WARNING"):
            status, _, raw = _http_call(
                "POST", "/api/customers", {**bad, "name": "Ok", "plan_type": ["both"]}, token=self.ptoken
            )
        self.assertEqual((status, json.loads(raw)["error"]), (400, "One of the fields has the wrong type"))
        status, _, _ = _http_call("POST", "/api/customer/login", {"phone": {"a": 1}, "pin": [1]})
        self.assertEqual(status, 401)
        status, _, _ = _http_call("GET", "/api/dashboard?date=not-a-date", token=self.ptoken)
        self.assertEqual(status, 400)

    def test_unexpected_errors_are_500_without_internal_details(self) -> None:
        with mock.patch.object(db, "get_dashboard_data", side_effect=RuntimeError("secret internal detail")):
            with self.assertLogs("dabbatrack", level="ERROR") as logs:
                status, _, raw = _http_call("GET", "/api/dashboard", token=self.ptoken)
        self.assertEqual(status, 500)
        self.assertNotIn("secret", raw.decode())
        self.assertIn("secret internal detail", "\n".join(logs.output))  # but the server log has it

    def test_locked_database_is_503_with_retry_after(self) -> None:
        locked = sqlite3.OperationalError("database is locked")
        with mock.patch.object(db, "get_dashboard_data", side_effect=locked), self.assertLogs("dabbatrack", "WARNING"):
            status, headers, _ = _http_call("GET", "/api/dashboard", token=self.ptoken)
        self.assertEqual(status, 503)
        self.assertEqual(headers["retry-after"], "2")

    def test_duplicate_phone_is_a_friendly_409(self) -> None:
        dup = {"name": "Dup", "phone": list(db.DEMO_CUSTOMER_PINS)[0], "address": "x", "plan_type": "both", "total_diets": 5}
        status, _, raw = _http_call("POST", "/api/customers", dup, token=self.ptoken)
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(raw)["error"], "A customer with this phone number already exists")

    def test_database_uses_wal_and_busy_timeout(self) -> None:
        with db.get_connection() as conn:
            self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
            self.assertGreaterEqual(conn.execute("PRAGMA busy_timeout").fetchone()[0], 10000)

    def test_push_partial_batch_failure_still_reports_and_cleans_tokens(self) -> None:
        calls = {"n": 0}

        def flaky(url, body, headers):
            calls["n"] += 1
            self.assertNotIn("Accept-Encoding", headers)  # urllib can't decode gzip
            if calls["n"] == 2:
                raise RuntimeError("Could not reach Expo push API: timeout")
            return {"data": [{"status": "ok", "id": "t"} if not m["to"].endswith("[dead]") else
                             {"status": "error", "details": {"error": "DeviceNotRegistered"}} for m in body]}

        messages = [{"to": f"ExponentPushToken[t{i}]"} for i in range(150)] + [{"to": "ExponentPushToken[dead]"}]
        messages[0] = {"to": "ExponentPushToken[dead]"}
        res = push.send_push_messages(messages, transport=flaky)
        self.assertEqual(res["sent"], 99)
        self.assertEqual(res["failed"], 52)  # 1 dead in chunk 1 + all 51 in the failed chunk 2
        self.assertEqual(res["invalid_tokens"], ["ExponentPushToken[dead]"])
        self.assertEqual(len(res["errors"]), 1)

        with self.assertRaises(RuntimeError):
            push.send_push_messages(messages[:3], transport=lambda *a: (_ for _ in ()).throw(RuntimeError("down")))

    def test_concurrent_read_modify_write_loses_no_updates(self) -> None:
        import threading as _threading

        with db.get_connection() as conn:
            start = conn.execute("SELECT boxes_with_customer FROM customers WHERE id = 1").fetchone()[0]

        def bump() -> None:
            for _ in range(10):
                with db.get_connection() as conn:
                    db.adjust_customer_boxes(conn, 1, 1)

        threads = [_threading.Thread(target=bump) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        with db.get_connection() as conn:
            end = conn.execute("SELECT boxes_with_customer FROM customers WHERE id = 1").fetchone()[0]
        self.assertEqual(end - start, 100)

    def test_server_close_waits_for_in_flight_requests(self) -> None:
        self.assertFalse(server.DabbaServer.daemon_threads)
        self.assertTrue(server.DabbaServer.block_on_close)
        self.assertEqual(server.TiffinHandler.timeout, server.REQUEST_TIMEOUT_S)


class ValidationTests(unittest.TestCase):
    """Phase 3: strict types, formats, lengths and ranges at every write."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.orig_db_path = db.DB_PATH
        db.DB_PATH = Path(self.tmp.name) / "validation.db"
        db.seed_demo_data(db.DB_PATH)
        server.LOGIN_LIMITER.reset()
        self.ptoken = _provider_token()
        self.cid, self.ctoken = _customer_token(list(db.DEMO_CUSTOMER_PINS)[0])
        self.today = date.today().isoformat()

    def tearDown(self) -> None:
        db.DB_PATH = self.orig_db_path
        self.tmp.cleanup()

    def _post(self, path: str, body: dict, token: str | None = None) -> tuple[int, str]:
        status, _, raw = _http_call("POST", path, body, token=token or self.ptoken)
        data = json.loads(raw)
        return status, data.get("error", "")

    def _new_customer(self, **overrides: Any) -> tuple[int, str]:
        body = {"name": "Neha Patel", "phone": "9123456780", "address": "Flat 1", "route_area": "Sector 9",
                "plan_type": "lunch_only", "total_diets": 20, "amount_paid": 1500}
        return self._post("/api/customers", {**body, **overrides})

    def test_unit_parsers(self) -> None:
        self.assertEqual(server.int_field({"n": "12"}, "n"), 12)
        self.assertEqual(server.int_field({"n": 12.0}, "n"), 12)
        for bad in (True, 12.5, "12a", [12]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                server.int_field({"n": bad}, "n")
        self.assertFalse(server.bool_field({"b": "false"}, "b"))  # bool("false") would be True
        self.assertTrue(server.bool_field({"b": 1}, "b"))
        with self.assertRaises(ValueError):
            server.bool_field({"b": "maybe"}, "b")
        self.assertEqual(server.num_field({"x": "1200.50"}, "x"), 1200.5)
        for bad in (float("nan"), float("inf"), False, "1e9"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                server.num_field({"x": bad}, "x")
        self.assertEqual(db.clean_phone("+91 98765-43210"), "9876543210")
        self.assertEqual(db.clean_phone("09876543210"), "9876543210")
        for bad in ("12345", "98765432101", "98765abcde"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                db.clean_phone(bad)

    def test_customer_creation_rules(self) -> None:
        cases = [
            ({"phone": "12345"}, "Phone number must be 10 digits"),
            ({"name": "   "}, "Name is required"),
            ({"name": "x" * 81}, "Name must be at most 80 characters"),
            ({"address": "a\x00b"}, "Address contains invalid characters"),
            ({"total_diets": 0}, "total_diets must be positive"),
            ({"total_diets": 5000}, "total_diets must be a whole number from 1 to 1000"),
            ({"total_diets": 2.5}, "total_diets must be a whole number"),
            ({"amount_paid": -1}, "amount_paid must be between 0 and 1,000,000"),
            ({"amount_paid": "abc"}, "amount_paid must be a number"),
            ({"start_date": "14/11/2026"}, "start_date must be a date like 2026-11-14"),
            ({"start_date": "2026-02-30"}, "start_date is not a real date"),
            ({"start_date": "2099-01-01"}, "start_date must be within 2 years of today"),
            ({"pin": "12a4"}, "Customer PIN must be exactly 4 digits"),
        ]
        for override, message in cases:
            with self.subTest(override=override):
                self.assertEqual(self._new_customer(**override), (400, message))
        # Normalised phone is stored, and the customer can log in with either format.
        status, _, raw = _http_call(
            "POST", "/api/customers",
            {"name": "Neha", "phone": "+91 91234-56780", "address": "Flat 1", "plan_type": "both", "total_diets": "10", "pin": "4321"},
            token=self.ptoken,
        )
        self.assertEqual(status, 201)
        for phone in ("9123456780", "+91 9123456780", "091234 56780"):
            with self.subTest(phone=phone):
                self.assertEqual(_http_call("POST", "/api/customer/login", {"phone": phone, "pin": "4321"})[0], 200)
        self.assertEqual(self._new_customer(phone="09123456780"), (409, "A customer with this phone number already exists"))

    def test_meal_and_schedule_rules(self) -> None:
        cases = [
            ("/api/meals/respond", {"customer_id": self.cid, "meal_type": "brunch", "wants_tiffin": True},
             "meal_type must be 'lunch' or 'dinner'"),
            ("/api/meals/respond", {"customer_id": self.cid, "meal_type": "dinner", "wants_tiffin": "perhaps"},
             "wants_tiffin must be true or false"),
            ("/api/meals/respond", {"customer_id": self.cid, "meal_type": "dinner", "wants_tiffin": True, "meal_date": "tomorrow"},
             "meal_date must be a date like 2026-11-14"),
            ("/api/meals/pause", {"customer_id": self.cid, "start_date": self.today, "end_date": "2026-13-01"},
             "end_date is not a real date"),
            ("/api/meals/scan-qr", {"customer_id": self.cid, "meal_type": "lunch", "qr_token": "x" * 500},
             "Invalid QR code scanned. Please scan the provider's tiffin QR."),
            ("/api/meals/scan-qr", {"customer_id": True, "meal_type": "lunch", "qr_token": "x"},
             "customer_id must be a whole number"),
        ]
        for path, body, message in cases:
            with self.subTest(path=path, body=body):
                self.assertEqual(self._post(path, body, token=self.ctoken), (400, message))

        provider_cases = [
            ("/api/menus", {"meal_type": "lunch", "items_text": "x" * 501}, "Menu must be at most 500 characters"),
            ("/api/menus", {"meal_type": "lunch", "items_text": "   "}, "Menu description cannot be empty"),
            ("/api/menus", {"meal_type": "lunch", "items_text": "Dal", "menu_date": "2026-1-5"}, "menu_date must be a date like 2026-11-14"),
            ("/api/holidays", {"holiday_date": self.today, "meal_scope": "full_day", "reason": "r" * 121},
             "Reason must be at most 120 characters"),
            (f"/api/customers/{self.cid}/boxes", {"delta": 500}, "delta must be a whole number from -100 to 100"),
            (f"/api/customers/{self.cid}/renew", {"plan_type": "both", "diets_added": 10, "amount_paid": float("nan")},
             None),  # NaN is rejected while parsing the JSON body
            ("/api/popup-broadcast", {"meal_type": "<script>"}, "meal_type must be 'lunch' or 'dinner'"),
            ("/api/push/send-meal-prompt", {"meal_type": "lunch", "dry_run": "nope"}, "dry_run must be true or false"),
        ]
        for path, body, message in provider_cases:
            with self.subTest(path=path, body=str(body)[:60]):
                if message is None:
                    raw = json.dumps(body).encode()  # json.dumps writes NaN literally
                    self.assertIn(b"NaN", raw)
                    status, _, resp = _http_call("POST", path, token=self.ptoken, raw=raw)
                    self.assertEqual((status, json.loads(resp)["error"]), (400, "Invalid JSON payload"))
                else:
                    self.assertEqual(self._post(path, body), (400, message))

    def test_valid_requests_still_work(self) -> None:
        self.assertEqual(self._post("/api/menus", {"meal_type": "lunch", "items_text": "Rajma\nChawal"})[0], 200)
        self.assertEqual(self._post(f"/api/customers/{self.cid}/renew", {"plan_type": "both", "diets_added": "10", "amount_paid": "800.50"})[0], 200)
        self.assertEqual(self._post(f"/api/customers/{self.cid}/boxes", {"delta": -1})[0], 200)
        self.assertEqual(self._post("/api/holidays", {"holiday_date": self.today, "meal_scope": "dinner"})[0], 201)
        self.assertEqual(self._new_customer()[0], 201)


class DeploymentTests(unittest.TestCase):
    """Phase 4: security headers, backups, time zone warning."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.orig_db_path = db.DB_PATH
        db.DB_PATH = Path(self.tmp.name) / "deploy.db"
        db.seed_demo_data(db.DB_PATH)

    def tearDown(self) -> None:
        db.DB_PATH = self.orig_db_path
        self.tmp.cleanup()

    def test_security_headers(self) -> None:
        status, headers, _ = _http_call("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertEqual(headers["x-frame-options"], "DENY")
        self.assertIn("frame-ancestors 'none'", headers["content-security-policy"])
        self.assertEqual(headers["cache-control"], "no-cache")
        status, headers, _ = _http_call("GET", "/api/health")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertNotIn("content-security-policy", headers)  # HTML only

    def test_backup_is_consistent_and_retention_only_touches_its_own_files(self) -> None:
        import backup

        dest = Path(self.tmp.name) / "backups"
        dest.mkdir()
        for stamp in ("20200101-000000", "20200102-000000", "20200103-000000"):
            (dest / f"tiffin-{stamp}.db").write_bytes(b"old")
        keep_me = dest / "tiffin-pre-phase1-manual.db"
        keep_me.write_bytes(b"manual")

        with db.get_connection() as conn:  # an uncommitted-to-main-file write still in the WAL
            db.set_daily_menu(conn, menu_date=date.today().isoformat(), meal_type="lunch", items_text="WAL check")
        path = backup.backup_database(dest, keep=2)

        names = sorted(p.name for p in dest.iterdir())
        self.assertEqual(names, sorted([path.name, "tiffin-20200103-000000.db", keep_me.name]))
        snap = sqlite3.connect(path)  # (sqlite3's `with` only commits; it doesn't close)
        try:
            self.assertEqual(snap.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            menu = snap.execute("SELECT items_text FROM daily_menus WHERE meal_type = 'lunch' ORDER BY id DESC").fetchone()[0]
            self.assertEqual(snap.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        finally:
            snap.close()
        self.assertEqual(menu, "WAL check")
        self.assertEqual(backup.main([str(dest), "--keep", "0"]), 1)  # bad args fail loudly

    def test_utc_clock_warning(self) -> None:
        with mock.patch.dict("os.environ", {"TZ": ""}):
            with mock.patch.object(server, "datetime") as fake_dt:
                fake_dt.now.return_value.astimezone.return_value.utcoffset.return_value = timedelta(0)
                self.assertTrue(server.clock_is_utc_by_default())
                fake_dt.now.return_value.astimezone.return_value.utcoffset.return_value = timedelta(hours=5, minutes=30)
                self.assertFalse(server.clock_is_utc_by_default())
        with mock.patch.dict("os.environ", {"TZ": "UTC"}), mock.patch.object(server, "datetime") as fake_dt:
            fake_dt.now.return_value.astimezone.return_value.utcoffset.return_value = timedelta(0)
            self.assertFalse(server.clock_is_utc_by_default())  # UTC chosen on purpose


if __name__ == "__main__":
    unittest.main(verbosity=2)
