"""Local-only iOS event testing workbench."""

from __future__ import annotations

import csv
import html
import hmac
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from core import evaluate_rules, log_timestamp, parse_event, redact, redact_properties, split_terms, summarize

ROOT = Path(__file__).resolve().parent
ENVIRONMENT = "local-test"
DATA = Path(os.environ.get("IOS_EVENT_LAB_DATA_DIR", ROOT / "data" / ENVIRONMENT))
DB = DATA / "events.sqlite3"
PASSIVE = os.environ.get("IOS_EVENT_LAB_PASSIVE") == "1"
BRIDGE_ORIGIN = "https://moulage.github.io"
BRIDGE_TOKEN = secrets.token_urlsafe(24)
MAX_LINES = 100_000
MAX_IMPORT_BYTES = 10 * 1024 * 1024
MAX_BODY = MAX_IMPORT_BYTES + 4096


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def connection():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def init_db():
    DATA.mkdir(parents=True, exist_ok=True)
    with connection() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
                device TEXT, created_at TEXT NOT NULL, status TEXT NOT NULL,
                error TEXT DEFAULT '', line_count INTEGER DEFAULT 0, event_count INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, occurred_at TEXT NOT NULL,
                time_source TEXT NOT NULL, line TEXT NOT NULL, event TEXT,
                properties TEXT, warning TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS logs_session_id ON logs(session_id, id);
            CREATE INDEX IF NOT EXISTS logs_event ON logs(session_id, event);
            CREATE TABLE IF NOT EXISTS rules (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
                event TEXT NOT NULL, config TEXT NOT NULL, enabled INTEGER DEFAULT 1
            );
        """)
        if not PASSIVE:
            db.execute("UPDATE sessions SET status='error', error='服务重启中断采集' WHERE status='running'")


def create_session(name: str, source: str, device: str = "") -> int:
    with connection() as db:
        cursor = db.execute(
            "INSERT INTO sessions(name, source, device, created_at, status) VALUES(?,?,?,?,?)",
            (name or f"采集 {now()[:16]}", source, device, now(), "running" if source == "usb" else "finished"),
        )
        return cursor.lastrowid


def append_line(session_id: int, line: str, source: str) -> bool:
    line = line.rstrip("\r\n")
    if not line:
        return True
    event = parse_event(line)
    with connection() as db:
        count = db.execute("SELECT line_count FROM sessions WHERE id=?", (session_id,)).fetchone()
        if not count or count[0] >= MAX_LINES:
            return False
        stamp = log_timestamp(line)
        db.execute(
            "INSERT INTO logs(session_id, occurred_at, time_source, line, event, properties, warning) VALUES(?,?,?,?,?,?,?)",
            (session_id, stamp or now(), "log" if stamp else ("capture" if source == "usb" else "import"),
             line, event["event"] if event else None, json.dumps(event["properties"], ensure_ascii=False) if event else None,
             event["warning"] if event else ""),
        )
        db.execute("UPDATE sessions SET line_count=line_count+1, event_count=event_count+? WHERE id=?",
                   (1 if event and event["event"] else 0, session_id))
    return True


def load_rows(session_id: int, *, events_only=False) -> list[dict]:
    query = "SELECT * FROM logs WHERE session_id=?" + (" AND event IS NOT NULL" if events_only else "") + " ORDER BY id"
    with connection() as db:
        rows = db.execute(query, (session_id,)).fetchall()
    return [{**dict(row), "properties": json.loads(row["properties"] or "{}") if row["event"] else {}} for row in rows]


def log_page(session_id: int, query: dict) -> tuple[list[dict], int]:
    events = split_terms(query.get("event", ""))
    search = query.get("search", "")
    if not events and query.get("kind") != "raw" and "/" in search:
        candidates = split_terms(search)
        if candidates and all(re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name) for name in candidates):
            events = candidates
            search = ""
    clauses = ["session_id=?", "id>?"]
    params = [session_id, int(query.get("after", "0"))]
    if query.get("kind") == "events" or events:
        clauses.append("event IS NOT NULL")
    elif query.get("kind") == "raw":
        clauses.append("event IS NULL")
    if events:
        clauses.append(f"event IN ({','.join('?' for _ in events)})")
        params.extend(events)
    if search:
        clauses.append("line LIKE ? ESCAPE '\\'")
        escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        params.append(f"%{escaped}%")
    where = " AND ".join(clauses)
    direction = "ASC" if query.get("order") == "asc" else "DESC"
    with connection() as db:
        total = db.execute(f"SELECT COUNT(*) FROM logs WHERE {where}", params).fetchone()[0]
        rows = db.execute(f"SELECT * FROM logs WHERE {where} ORDER BY occurred_at {direction}, id {direction} LIMIT 500", params).fetchall()
    return [{**dict(row), "properties": json.loads(row["properties"] or "{}") if row["event"] else {}} for row in rows], total


def clear_local_logs(data: dict) -> int:
    if ENVIRONMENT != "local-test" or data.get("environment") != ENVIRONMENT or data.get("confirm") != "CLEAR_LOCAL_TEST_LOGS":
        raise ValueError("仅允许确认后清除 local-test 数据")
    if PASSIVE:
        raise ValueError("只读页面不能清除采集数据")
    with capture.lock:
        if capture.process is not None and capture.process.poll() is None:
            raise ValueError("采集中不能清除日志，请先停止采集")
        with connection() as db:
            if db.execute("SELECT 1 FROM sessions WHERE status='running' LIMIT 1").fetchone():
                raise ValueError("采集中不能清除日志，请先停止采集")
            count = db.execute("SELECT COUNT(*) FROM logs").fetchone()[0]
            db.execute("DELETE FROM logs")
            db.execute("UPDATE sessions SET line_count=0, event_count=0, status='cleared', error=''")
    return count


def public_row(row: dict) -> dict:
    return {**row, "line": redact(row["line"]), "properties": redact_properties(row["properties"])}


def public_session(session: dict) -> dict:
    return {**session, "name": redact(session["name"]),
            "device": "[REDACTED]" if session.get("device") else ""}


def local_page() -> bytes:
    static = ROOT / "static"
    page = (static / "index.html").read_text(encoding="utf-8")
    styles = "\n".join((static / name).read_text(encoding="utf-8") for name in
                       ("style.css", "filters.css", "detail.css", "layout.css"))
    script = (static / "app.js").read_text(encoding="utf-8")
    if "</style" in styles.lower() or "</script" in script.lower():
        raise ValueError("静态资源包含无法内联的结束标签")
    try:
        device_data = list_devices()
    except (subprocess.SubprocessError, OSError) as exc:
        device_data = {"devices": [], "error": str(exc)}
    devices = device_data["devices"]
    options = "".join(
        f'<option value="{html.escape(device["id"], quote=True)}">'
        f'{html.escape(device["name"])} · {html.escape(device["id"][-8:])}</option>'
        for device in devices
    ) or f'<option value="">{html.escape(device_data.get("error") or "未发现 USB 真机")}</option>'
    return (page.replace("<!-- IOS_EVENT_STYLES -->", f"<style>{styles}</style>")
            .replace("<!-- IOS_EVENT_DEVICE_CLASS -->", "live" if devices else "neutral")
            .replace("<!-- IOS_EVENT_DEVICE_STATUS -->", f"{len(devices)} 台设备" if devices else "未连接")
            .replace("<!-- IOS_EVENT_DEVICE_OPTIONS -->", options)
            .replace("<!-- IOS_EVENT_APP -->", f"<script>{script}</script>").encode("utf-8"))


def list_rules() -> list[dict]:
    with connection() as db:
        rows = db.execute("SELECT * FROM rules ORDER BY id DESC").fetchall()
    return [{**json.loads(row["config"]), "id": row["id"], "name": row["name"],
             "kind": row["kind"], "event": row["event"], "enabled": bool(row["enabled"])} for row in rows]


def validate_rule(rule: dict) -> dict:
    if not isinstance(rule, dict):
        raise ValueError("规则必须是 JSON 对象")
    kind = rule.get("kind", "presence")
    if kind not in {"presence", "count", "attribute", "sequence"}:
        raise ValueError("不支持的规则类型")
    event = str(rule.get("event", "")).strip()
    if not event:
        raise ValueError("事件名不能为空")
    if kind == "attribute" and not str(rule.get("field", "")).strip():
        raise ValueError("属性规则需要字段名")
    if kind == "attribute" and rule.get("operator", "exists") not in {"exists", "equals", "regex"}:
        raise ValueError("不支持的字段比较方式")
    if kind == "sequence" and not str(rule.get("next_event", "")).strip():
        raise ValueError("顺序规则需要后续事件名")
    if kind == "count":
        minimum = int(rule.get("minimum", 1))
        maximum = rule.get("maximum")
        if minimum < 0 or (maximum not in (None, "") and int(maximum) < minimum):
            raise ValueError("次数范围无效")
    if kind == "sequence" and rule.get("max_seconds") not in (None, "") and float(rule["max_seconds"]) < 0:
        raise ValueError("时间间隔不能为负数")
    return {**rule, "event": event, "kind": kind, "name": str(rule.get("name") or event).strip()}


class Capture:
    def __init__(self):
        self.lock = threading.Lock()
        self.process = None
        self.session_id = None
        self.thread = None
        self.stopping = set()

    def state(self):
        with self.lock:
            if PASSIVE:
                with connection() as db:
                    row = db.execute("SELECT id FROM sessions WHERE status='running' ORDER BY id DESC LIMIT 1").fetchone()
                return {"running": bool(row), "session_id": row["id"] if row else None, "passive": True}
            return {"running": self.process is not None and self.process.poll() is None,
                    "session_id": self.session_id, "passive": False}

    def start(self, udid: str, name: str) -> int:
        if PASSIVE:
            raise ValueError("此页面仅查看正在采集的会话，请在原工作台控制设备采集")
        if not shutil.which("idevicesyslog"):
            raise RuntimeError("缺少 idevicesyslog，请安装 libimobiledevice")
        devices = subprocess.run(["idevice_id", "-l"], capture_output=True, text=True, timeout=8, check=True).stdout.splitlines()
        if udid not in devices:
            raise ValueError("设备未连接或尚未信任此 Mac")
        with self.lock:
            if self.process and self.process.poll() is None:
                raise ValueError("已有采集正在运行")
            session_id = create_session(name, "usb", udid)
            self.process = subprocess.Popen(
                ["idevicesyslog", "-u", udid, "-x", "--no-colors", "-p", "ktv"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            )
            self.session_id = session_id
            self.thread = threading.Thread(target=self._read, args=(session_id, self.process), daemon=True)
            self.thread.start()
            return session_id

    def _read(self, session_id, process):
        error = ""
        try:
            for line in process.stdout:
                if not append_line(session_id, line, "usb"):
                    error = f"达到单次采集上限 {MAX_LINES} 行，已自动停止"
                    process.terminate()
                    break
            code = process.wait(timeout=5)
            if code and not error and session_id not in self.stopping:
                error = f"日志采集进程退出，代码 {code}；请检查连接和信任状态"
        except Exception as exc:
            error = f"采集失败：{exc}"
            if process.poll() is None:
                process.terminate()
        finally:
            with connection() as db:
                db.execute("UPDATE sessions SET status=?, error=? WHERE id=?",
                           ("error" if error else "finished", error, session_id))
            with self.lock:
                self.stopping.discard(session_id)
                if self.process is process:
                    self.process = None

    def stop(self):
        if PASSIVE:
            return self.state()
        with self.lock:
            process = self.process
            if process and self.session_id:
                self.stopping.add(self.session_id)
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        return self.state()


capture = Capture()


def list_devices() -> dict:
    if not shutil.which("idevice_id"):
        return {"devices": [], "error": "缺少 libimobiledevice"}
    ids = subprocess.run(["idevice_id", "-l"], capture_output=True, text=True, timeout=8, check=True).stdout.splitlines()
    devices = []
    for value in ids:
        try:
            name = subprocess.run(["ideviceinfo", "-u", value, "-k", "DeviceName"],
                                  capture_output=True, text=True, timeout=3, check=True).stdout.strip()
        except (subprocess.SubprocessError, OSError):
            name = "iPhone " + value[-6:]
        devices.append({"id": value, "name": name or "iPhone " + value[-6:]})
    return {"devices": devices, "environment": ENVIRONMENT}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def end_headers(self):
        if urlparse(self.path).path.startswith("/api/bridge/") and self.headers.get("Origin") == BRIDGE_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", BRIDGE_ORIGIN)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token")
            self.send_header("Vary", "Origin")
        super().end_headers()

    def allowed_request(self, *, bridge=False, code=False) -> bool:
        port = self.server.server_address[1]
        local_origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
        if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            self.respond({"error": "仅允许从本机地址访问"}, 403)
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in (local_origins if code or not bridge else local_origins | {BRIDGE_ORIGIN}):
            self.respond({"error": "不允许的网页来源"}, 403)
            return False
        if bridge and not code and not hmac.compare_digest(self.headers.get("X-Bridge-Token", ""), BRIDGE_TOKEN):
            self.respond({"error": "连接码无效，请从本机工作台重新复制"}, 401)
            return False
        return True

    def respond(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
            raise ValueError("请求必须使用 application/json")
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            raise ValueError("请求内容为空或超过 10 MB")
        data = json.loads(self.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError("请求必须是 JSON 对象")
        return data

    def do_GET(self):
        url = urlparse(self.path)
        query = {key: value[0] for key, value in parse_qs(url.query).items()}
        try:
            bridge = url.path.startswith("/api/bridge/")
            if not self.allowed_request(bridge=bridge, code=url.path == "/api/bridge/code"):
                return
            if url.path == "/api/bridge/code":
                return self.respond({"code": BRIDGE_TOKEN, "environment": ENVIRONMENT})
            if url.path == "/api/bridge/status":
                return self.respond({**capture.state(), "environment": ENVIRONMENT})
            if url.path == "/api/bridge/devices":
                return self.respond(list_devices())
            if url.path == "/api/bridge/sessions":
                with connection() as db:
                    rows = db.execute("SELECT * FROM sessions ORDER BY id DESC LIMIT 100").fetchall()
                return self.respond({"sessions": [public_session(dict(row)) for row in rows]})
            if url.path == "/api/bridge/logs":
                session_id = int(query.get("session", "0"))
                with connection() as db:
                    session = db.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
                if not session:
                    return self.respond({"error": "会话不存在"}, 404)
                rows, total = log_page(session_id, query)
                return self.respond({"rows": [public_row(row) for row in rows], "total": total,
                                     "session": public_session(dict(session))})
            if url.path == "/api/bridge/analysis":
                session_id = int(query.get("session", "0"))
                with connection() as db:
                    session = db.execute("SELECT id FROM sessions WHERE id=?", (session_id,)).fetchone()
                if not session:
                    return self.respond({"error": "会话不存在"}, 404)
                return self.respond({"summary": summarize(load_rows(session_id, events_only=True))})
            if url.path == "/api/devices":
                return self.respond(list_devices())
            if url.path == "/api/capture":
                return self.respond(capture.state())
            if url.path == "/api/sessions":
                with connection() as db:
                    rows = db.execute("SELECT * FROM sessions ORDER BY id DESC LIMIT 100").fetchall()
                return self.respond({"sessions": [dict(row) for row in rows]})
            if url.path == "/api/rules":
                return self.respond({"rules": list_rules()})
            if url.path == "/api/rules/export":
                return self.respond({"format": "ios-event-lab-rules-v1", "rules": list_rules()})
            if url.path in {"/api/logs", "/api/analysis", "/api/export"}:
                session_id = int(query.get("session", "0"))
                with connection() as db:
                    session = db.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
                if not session:
                    return self.respond({"error": "会话不存在"}, 404)
                if url.path == "/api/logs":
                    rows, total = log_page(session_id, query)
                    return self.respond({"rows": [public_row(row) for row in rows], "total": total, "session": dict(session)})
                events = load_rows(session_id, events_only=True)
                if url.path == "/api/analysis":
                    rules = [rule for rule in list_rules() if rule["enabled"]]
                    return self.respond({"summary": summarize(events),
                                         "rules": evaluate_rules(rules, events, session["status"] != "running"),
                                         "session": dict(session)})
                if query.get("format") == "csv":
                    output = io.StringIO()
                    writer = csv.writer(output)
                    writer.writerow(["时间", "事件", "属性 JSON", "解析提示", "原文（脱敏）"])
                    for row in events:
                        item = public_row(row)
                        writer.writerow([row["occurred_at"], row["event"], json.dumps(item["properties"], ensure_ascii=False), row["warning"], item["line"]])
                    data = output.getvalue().encode("utf-8-sig")
                    mime = "text/csv; charset=utf-8"
                    ext = "csv"
                else:
                    data = json.dumps({"session": public_session(dict(session)), "events": [public_row(row) for row in events],
                                       "summary": summarize(events)}, ensure_ascii=False, indent=2).encode()
                    mime = "application/json; charset=utf-8"
                    ext = "json"
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Disposition", f'attachment; filename="ios-events-{session_id}.{ext}"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            path = ROOT / "static" / ("index.html" if url.path == "/" else url.path.lstrip("/"))
            if not path.resolve().is_relative_to((ROOT / "static").resolve()) or not path.is_file():
                return self.send_error(404)
            mime = {".html": "text/html", ".css": "text/css", ".js": "text/javascript"}.get(path.suffix, "application/octet-stream")
            data = local_page() if url.path in {"/", "/index.html"} else path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mime + "; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        except (ValueError, sqlite3.Error, subprocess.SubprocessError, OSError) as exc:
            self.respond({"error": str(exc)}, 400)

    def do_POST(self):
        try:
            bridge = self.path.startswith("/api/bridge/")
            if not self.allowed_request(bridge=bridge):
                return
            data = self.body()
            if self.path == "/api/bridge/start":
                return self.respond({"session_id": capture.start(str(data.get("udid", "")), str(data.get("name", "")))}, 201)
            if self.path == "/api/bridge/stop":
                return self.respond(capture.stop())
            if self.path == "/api/capture/start":
                session_id = capture.start(str(data.get("udid", "")), str(data.get("name", "")))
                return self.respond({"session_id": session_id}, 201)
            if self.path == "/api/capture/stop":
                return self.respond(capture.stop())
            if self.path == "/api/sessions/clear":
                return self.respond({"cleared_logs": clear_local_logs(data)})
            if self.path == "/api/sessions/import":
                content = str(data.get("text", ""))
                if len(content.encode()) > MAX_IMPORT_BYTES:
                    raise ValueError("导入文件超过 10 MB")
                session_id = create_session(str(data.get("name", "导入会话")), "import")
                for line in content.splitlines():
                    if not append_line(session_id, line, "import"):
                        break
                return self.respond({"session_id": session_id}, 201)
            if self.path == "/api/rules":
                rule = validate_rule(data)
                with connection() as db:
                    cursor = db.execute("INSERT INTO rules(name, kind, event, config, enabled) VALUES(?,?,?,?,?)",
                        (rule["name"], rule["kind"], rule["event"], json.dumps(rule, ensure_ascii=False), 1))
                return self.respond({"id": cursor.lastrowid}, 201)
            if self.path == "/api/rules/import":
                incoming = data.get("rules")
                if not isinstance(incoming, list) or len(incoming) > 200:
                    raise ValueError("规则文件应包含不超过 200 条 rules 数组")
                rules = [validate_rule(item) for item in incoming]
                with connection() as db:
                    for rule in rules:
                        db.execute("INSERT INTO rules(name, kind, event, config, enabled) VALUES(?,?,?,?,?)",
                                   (rule["name"], rule["kind"], rule["event"],
                                    json.dumps(rule, ensure_ascii=False), 1))
                return self.respond({"imported": len(rules)}, 201)
            return self.send_error(404)
        except (ValueError, RuntimeError, sqlite3.Error, subprocess.SubprocessError, OSError, json.JSONDecodeError) as exc:
            self.respond({"error": str(exc)}, 400)

    def do_DELETE(self):
        if not self.allowed_request():
            return
        if not self.path.startswith("/api/rules/"):
            return self.send_error(404)
        try:
            rule_id = int(self.path.rsplit("/", 1)[-1])
            with connection() as db:
                db.execute("DELETE FROM rules WHERE id=?", (rule_id,))
            return self.respond({"ok": True})
        except (ValueError, sqlite3.Error) as exc:
            self.respond({"error": str(exc)}, 400)

    def do_OPTIONS(self):
        if not self.path.startswith("/api/bridge/"):
            return self.send_error(404)
        port = self.server.server_address[1]
        if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"} or self.headers.get("Origin") != BRIDGE_ORIGIN:
            return self.send_error(403)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    init_db()
    port = int(os.environ.get("IOS_EVENT_LAB_PORT", "8766"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"iOS Event Lab [{ENVIRONMENT}]: http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    finally:
        capture.stop()
        server.server_close()


if __name__ == "__main__":
    main()
