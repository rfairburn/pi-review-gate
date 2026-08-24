#!/usr/bin/env python3
"""Small JSON bridge from pi-review-gate WebSearch to DDGS."""

from __future__ import annotations

import json
import sys
from typing import Any


def required_int(request: dict[str, Any], name: str, minimum: int, maximum: int) -> int:
    value = request.get(name)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        raise ValueError(f"{name} must be an integer from {minimum} through {maximum}")
    return value


def optional_string(request: dict[str, Any], name: str) -> str | None:
    value = request.get(name)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value.strip()


def main() -> None:
    from ddgs import DDGS

    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
    query = optional_string(request, "query")
    if query is None:
        raise ValueError("query is required")
    max_results = required_int(request, "maxResults", 1, 100)
    page = required_int(request, "page", 1, 100)
    timeout_ms = required_int(request, "timeoutMs", 1, 3_600_000)
    region = optional_string(request, "region") or "us-en"
    timelimit = optional_string(request, "timelimit")
    if timelimit not in (None, "d", "w", "m", "y"):
        raise ValueError("timelimit must be d, w, m, or y")

    rows = DDGS(timeout=max(1, (timeout_ms + 999) // 1000)).text(
        query,
        region=region,
        timelimit=timelimit,
        max_results=max_results,
        page=page,
        backend="auto",
    )
    results = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = row.get("title")
        href = row.get("href")
        body = row.get("body")
        if not isinstance(title, str) or not isinstance(href, str) or not isinstance(body, str):
            continue
        result = {"title": title, "href": href, "body": body}
        if isinstance(row.get("date"), str) and row["date"]:
            result["date"] = row["date"]
        results.append(result)

    json.dump({"ok": True, "results": results, "hasMore": len(rows) >= max_results}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        json.dump({"ok": False, "error": str(error) or error.__class__.__name__}, sys.stdout)
        sys.exit(1)
