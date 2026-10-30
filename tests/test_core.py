import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server
from core import evaluate_rules, parse_event, redact, redact_properties, split_terms, summarize
from server import Handler, public_session, validate_rule


class EventCoreTests(unittest.TestCase):
    def test_parse_actual_debug_format(self):
        line = "sensor statitic -- event: changba_page_will_appear, is_member: 1, page_name: KTVHomePageViewController, refer_page: , op: 1"
        event = parse_event(line)
        self.assertEqual(event["event"], "changba_page_will_appear")
        self.assertEqual(event["properties"]["page_name"], "KTVHomePageViewController")
        self.assertEqual(event["properties"]["refer_page"], "")
        self.assertEqual(event["warning"], "")

    def test_preserve_comma_inside_value(self):
        event = parse_event("sensor statitic -- event: play, title: hello, world, op: 2")
        self.assertEqual(event["properties"]["title"], "hello, world")

    def test_nested_property_warns(self):
        event = parse_event("sensor statitic -- event: play, info: {a: 1, b: 2}, op: 2")
        self.assertIn("核对", event["warning"])

    def test_redact_log_and_properties(self):
        text = "https://api-test.example?curuserid=123&token=abc&secret=xyz idfv: ABC"
        result = redact(text)
        self.assertNotIn("abc", result)
        self.assertNotIn("xyz", result)
        self.assertNotIn("123", result)
        self.assertNotIn("ABC", result)
        self.assertEqual(redact_properties({"token": "abc", "page_name": "home"}),
                         {"token": "[REDACTED]", "page_name": "home"})

    def test_rules_and_live_pending(self):
        events = [
            {"id": 1, "event": "open", "properties": {"page": "home"}, "occurred_at": "2026-10-29T10:00:00", "time_source": "capture"},
            {"id": 2, "event": "click", "properties": {"op": "2"}, "occurred_at": "2026-10-29T10:00:02", "time_source": "capture"},
        ]
        rules = [
            {"kind": "presence", "event": "open"},
            {"kind": "count", "event": "click", "minimum": 2},
            {"kind": "attribute", "event": "open", "field": "page", "operator": "equals", "expected": "home"},
            {"kind": "sequence", "event": "open", "next_event": "click", "max_seconds": 3},
        ]
        self.assertEqual([item["status"] for item in evaluate_rules(rules, events, False)],
                         ["pass", "pending", "pass", "pass"])
        self.assertEqual(evaluate_rules(rules, events, True)[1]["status"], "fail")
        self.assertEqual(summarize(events)["by_event"], [("open", 1), ("click", 1)])

    def test_imported_time_is_unknown_for_interval(self):
        events = [
            {"id": 1, "event": "open", "properties": {}, "occurred_at": "2026-10-29T10:00:00", "time_source": "import"},
            {"id": 2, "event": "click", "properties": {}, "occurred_at": "2026-10-29T10:00:00", "time_source": "import"},
        ]
        result = evaluate_rules([{"kind": "sequence", "event": "open", "next_event": "click", "max_seconds": 3}], events, True)
        self.assertEqual(result[0]["status"], "unknown")

    def test_no_detected_events_is_unknown(self):
        result = evaluate_rules([{"kind": "presence", "event": "open"}], [], True)
        self.assertEqual(result[0]["status"], "unknown")

    def test_invalid_rule_range(self):
        with self.assertRaises(ValueError):
            validate_rule({"kind": "count", "event": "click", "minimum": 3, "maximum": 1})

    def test_slash_separated_events(self):
        self.assertEqual(split_terms(" open / click / open "), ["open", "click"])
        with self.assertRaises(ValueError):
            split_terms("/".join(str(index) for index in range(51)))

    def test_database_log_page_with_multiple_filters(self):
        with tempfile.TemporaryDirectory(prefix="local-test-ios-events-") as path:
            data = Path(path)
            with patch.object(server, "DATA", data), patch.object(server, "DB", data / "events.sqlite3"):
                server.init_db()
                session_id = server.create_session("filter test local-test", "import")
                for line in (
                    "sensor statitic -- event: open, page: home",
                    "sensor statitic -- event: click, op: 2",
                    "sensor statitic -- event: close, reason: done",
                ):
                    server.append_line(session_id, line, "import")
                rows, total = server.log_page(session_id, {"event": "open / click", "kind": "events"})
                self.assertEqual((total, [row["event"] for row in rows]), (2, ["click", "open"]))
                rows, total = server.log_page(session_id, {"search": "open/click", "kind": "events"})
                self.assertEqual((total, [row["event"] for row in rows]), (2, ["click", "open"]))
                rows, total = server.log_page(session_id, {"field": "page/op", "value": "2", "kind": "events"})
                self.assertEqual((total, [row["event"] for row in rows]), (3, ["close", "click", "open"]))
                rows, total = server.log_page(session_id, {"kind": "events", "order": "asc"})
                self.assertEqual((total, [row["event"] for row in rows]), (3, ["open", "click", "close"]))

    def test_clear_local_test_logs_preserves_sessions_and_rules(self):
        with tempfile.TemporaryDirectory(prefix="local-test-ios-events-") as path:
            data = Path(path)
            with patch.object(server, "DATA", data), patch.object(server, "DB", data / "events.sqlite3"):
                server.init_db()
                session_id = server.create_session("clear test local-test", "import")
                server.append_line(session_id, "sensor statitic -- event: open, page: home", "import")
                with server.connection() as db:
                    db.execute("INSERT INTO rules(name, kind, event, config) VALUES(?,?,?,?)",
                               ("open", "presence", "open", "{}"))
                with self.assertRaises(ValueError):
                    server.clear_local_logs({"environment": "local-test", "confirm": "wrong"})
                with server.connection() as db:
                    db.execute("UPDATE sessions SET status='running' WHERE id=?", (session_id,))
                with self.assertRaisesRegex(ValueError, "采集中"):
                    server.clear_local_logs({"environment": "local-test", "confirm": "CLEAR_LOCAL_TEST_LOGS"})
                with server.connection() as db:
                    db.execute("UPDATE sessions SET status='finished' WHERE id=?", (session_id,))
                self.assertEqual(server.clear_local_logs({"environment": "local-test", "confirm": "CLEAR_LOCAL_TEST_LOGS"}), 1)
                with server.connection() as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM logs").fetchone()[0], 0)
                    self.assertEqual(tuple(db.execute("SELECT line_count, event_count FROM sessions WHERE id=?", (session_id,)).fetchone()), (0, 0))
                    self.assertEqual(db.execute("SELECT status FROM sessions WHERE id=?", (session_id,)).fetchone()[0], "cleared")
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM rules").fetchone()[0], 1)

    def test_export_session_masks_device(self):
        result = public_session({"name": "test", "device": "00008110-00180DD22242801E"})
        self.assertEqual(result["device"], "[REDACTED]")

    def test_local_page_contains_styles_and_app_without_asset_requests(self):
        with patch.object(server, "list_devices", return_value={"devices": []}):
            page = server.local_page().decode("utf-8")
        self.assertIn(".workspace{", page)
        self.assertIn("window.iosEventAppLoaded = true", page)
        self.assertNotIn('href="/style.css"', page)
        self.assertNotIn('src="/app.js"', page)

    def test_local_page_shows_detected_device_before_script_runs(self):
        devices = {"devices": [{"id": "device-12345678", "name": "Test <iPhone>"}]}
        with patch.object(server, "list_devices", return_value=devices):
            page = server.local_page().decode("utf-8")
        self.assertIn('id="connectionBadge" class="badge live">1 台设备', page)
        self.assertIn('value="device-12345678">Test &lt;iPhone&gt; · 12345678', page)

    def test_json_request_works_through_preview_origin(self):
        payload = json.dumps({"udid": "test-device"}).encode()
        handler = object.__new__(Handler)
        handler.headers = {"Content-Type": "application/json", "Content-Length": str(len(payload)),
                           "Origin": "https://preview.example.test"}
        handler.rfile = io.BytesIO(payload)
        self.assertEqual(handler.body(), {"udid": "test-device"})
        handler.headers["Content-Type"] = "text/plain"
        with self.assertRaises(ValueError):
            handler.body()

    def test_bridge_requires_allowed_origin_and_code(self):
        with tempfile.TemporaryDirectory(prefix="local-test-ios-bridge-") as path:
            data = Path(path)
            with patch.object(server, "DATA", data), patch.object(server, "DB", data / "events.sqlite3"), \
                 patch.object(server, "BRIDGE_TOKEN", "test-only-bridge-code"):
                server.init_db()
                session_id = server.create_session("local-test bridge", "import")
                server.append_line(session_id, "sensor statitic -- event: open, token: private-value", "import")
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{httpd.server_address[1]}"

                def request(path, *, origin=server.BRIDGE_ORIGIN, code="test-only-bridge-code", method="GET", body=None):
                    headers = {"Origin": origin}
                    if code:
                        headers["X-Bridge-Token"] = code
                    if body is not None:
                        headers["Content-Type"] = "application/json"
                    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                                 headers=headers, method=method)
                    try:
                        with urllib.request.urlopen(req, timeout=3) as response:
                            return response.status, response.headers, response.read().decode()
                    except urllib.error.HTTPError as error:
                        return error.code, error.headers, error.read().decode()

                try:
                    status, headers, body = request("/api/bridge/logs?session=" + str(session_id))
                    self.assertEqual(status, 200)
                    self.assertEqual(headers["Access-Control-Allow-Origin"], server.BRIDGE_ORIGIN)
                    self.assertNotIn("private-value", body)
                    self.assertEqual(json.loads(body)["rows"][0]["properties"]["token"], "[REDACTED]")
                    self.assertEqual(request("/api/bridge/status", code="wrong")[0], 401)
                    self.assertEqual(request("/api/bridge/status", origin="https://evil.example")[0], 403)
                    self.assertEqual(request("/api/bridge/code")[0], 403)
                    self.assertEqual(request("/api/capture/start", body={"udid": "fake"}, method="POST")[0], 403)
                    status, headers, _ = request("/api/bridge/status", code="", method="OPTIONS")
                    self.assertEqual(status, 204)
                    self.assertEqual(headers["Access-Control-Allow-Origin"], server.BRIDGE_ORIGIN)
                    with patch.object(server.capture, "start", return_value=321) as start:
                        self.assertEqual(request("/api/bridge/start", code="wrong", method="POST", body={})[0], 401)
                        status, _, body = request("/api/bridge/start", method="POST", body={"udid": "test", "name": "demo"})
                        self.assertEqual((status, json.loads(body)["session_id"]), (201, 321))
                        start.assert_called_once_with("test", "demo")
                    with patch.object(server.capture, "stop", return_value={"running": False}) as stop:
                        self.assertEqual(request("/api/bridge/stop", method="POST", body={})[0], 200)
                        stop.assert_called_once()
                    req = urllib.request.Request(base + "/api/bridge/code")
                    with urllib.request.urlopen(req, timeout=3) as response:
                        self.assertEqual(json.load(response)["code"], "test-only-bridge-code")
                finally:
                    httpd.shutdown()
                    httpd.server_close()
                    thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
