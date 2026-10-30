"""Parsing, filtering, rule evaluation, and redaction for iOS event logs."""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime

MARKER = "sensor statitic -- event:"
FIELD = re.compile(r",\s+([A-Za-z_$][\w$.-]*):\s*")
LOG_TIME = re.compile(r"(?:^|\s)(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?)")
SENSITIVE = re.compile(
    r"(?i)((?:[\"']?\b(?:token|access_token|secret|password|passwd|authorization|userid|curuserid|user_id|"
    r"idfa|idfv|smdeviceid|device_id|cid|uuid)\b[\"']?)\s*[:=]\s*[\"']?)[^\s,;&\"'}]+"
)


def parse_event(line: str) -> dict | None:
    at = line.find(MARKER)
    if at < 0:
        return None
    payload = line[at + len(MARKER):].strip()
    first = FIELD.search(payload)
    name = (payload[:first.start()] if first else payload).strip().strip(",")
    if not name:
        return {"event": "", "properties": {}, "warning": "事件名为空"}
    properties = {}
    warning = ""
    matches = list(FIELD.finditer(payload))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(payload)
        key = match.group(1)
        value = payload[match.end():end].strip()
        if key in properties:
            warning = "存在重复属性名；请核对原文"
        properties[key] = value
    if re.search(r"[{}]", payload):
        warning = "属性包含嵌套内容；请核对原文"
    return {"event": name, "properties": properties, "warning": warning}


def log_timestamp(line: str) -> str | None:
    match = LOG_TIME.search(line)
    if not match:
        return None
    value = match.group(1).replace(" ", "T")
    try:
        return datetime.fromisoformat(value).isoformat()
    except ValueError:
        return None


def redact(value: str) -> str:
    return SENSITIVE.sub(r"\1[REDACTED]", value)


def redact_properties(properties: dict) -> dict:
    return {key: "[REDACTED]" if re.search(
        r"(?i)token|secret|password|passwd|authorization|userid|user_id|idfa|idfv|smdeviceid|device_id|cid|uuid",
        key,
    ) else redact(str(value)) for key, value in properties.items()}


def split_terms(raw: str) -> list[str]:
    terms = list(dict.fromkeys(part.strip() for part in raw.split("/") if part.strip()))
    if len(terms) > 50:
        raise ValueError("单次最多筛选 50 个事件名或属性名")
    return terms


def evaluate_rules(rules: list[dict], events: list[dict], finished: bool) -> list[dict]:
    results = []
    by_name = {}
    for item in events:
        by_name.setdefault(item["event"], []).append(item)

    for rule in rules:
        name = rule.get("event", "").strip()
        matches = by_name.get(name, [])
        kind = rule.get("kind", "presence")
        passed = False
        detail = ""
        if kind == "presence":
            passed = bool(matches)
            detail = f"命中 {len(matches)} 条"
        elif kind == "count":
            minimum = max(0, int(rule.get("minimum", 1)))
            maximum = rule.get("maximum")
            maximum = int(maximum) if maximum not in (None, "") else None
            passed = len(matches) >= minimum and (maximum is None or len(matches) <= maximum)
            detail = f"实际 {len(matches)} 条；期望 {minimum}～{maximum if maximum is not None else '不限'} 条"
        elif kind == "attribute":
            field = rule.get("field", "").strip()
            operator = rule.get("operator", "exists")
            expected = str(rule.get("expected", ""))
            if operator == "regex":
                try:
                    pattern = re.compile(expected)
                except re.error:
                    results.append({**rule, "status": "invalid", "detail": "正则表达式无效"})
                    continue
            def acceptable(item):
                value = item.get("properties", {}).get(field)
                if value is None:
                    return False
                if operator == "exists":
                    return str(value) != ""
                if operator == "equals":
                    return str(value) == expected
                if operator == "regex":
                    return bool(pattern.search(str(value)))
                return False
            passed = any(acceptable(item) for item in matches)
            detail = f"{len(matches)} 条事件中有 {sum(acceptable(item) for item in matches)} 条满足 {field} 条件"
        elif kind == "sequence":
            next_name = rule.get("next_event", "").strip()
            max_seconds = rule.get("max_seconds")
            limit = float(max_seconds) if max_seconds not in (None, "") else None
            unknown_time = False
            for left in matches:
                for right in by_name.get(next_name, []):
                    if right["id"] <= left["id"]:
                        continue
                    if limit is None:
                        passed = True
                        break
                    try:
                        start = datetime.fromisoformat(left["occurred_at"])
                        end = datetime.fromisoformat(right["occurred_at"])
                        if left.get("time_source") == "import" or right.get("time_source") == "import":
                            unknown_time = True
                            continue
                        if 0 <= (end - start).total_seconds() <= limit:
                            passed = True
                            break
                    except (KeyError, TypeError, ValueError):
                        unknown_time = True
                if passed:
                    break
            detail = f"{name} → {next_name}" + (f"，{limit:g} 秒内" if limit is not None else "")
            if not passed and unknown_time:
                results.append({**rule, "status": "unknown", "detail": detail + "；日志缺少可信时间戳"})
                continue
        else:
            results.append({**rule, "status": "invalid", "detail": "未知规则类型"})
            continue
        if passed:
            status = "pass"
        elif not finished:
            status = "pending"
        elif not events:
            status = "unknown"
            detail += "；当前会话未识别到任何埋点，请检查采集通道"
        else:
            status = "fail"
        results.append({**rule, "status": status, "detail": detail})
    return results


def summarize(events: list[dict]) -> dict:
    counts = Counter(row["event"] for row in events)
    trend = Counter(row["occurred_at"][:16] for row in events)
    return {"total": len(events), "by_event": counts.most_common(), "trend": sorted(trend.items())}
