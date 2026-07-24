# -*- coding: utf-8 -*-
"""Fixed panel callback protocol for remaining-time scheduling.

Scripts always report when they know remaining_sec. Whether the panel uses
the report for scheduling is controlled by the task condition switch
(type = remaining_callback).

Usage:
    from lib.panel_callback import report_remaining, write_task_result

    report_remaining(remaining_sec=38820, valid_until="2026-07-24 16:36", action="skip")
    # or merge into a full result:
    write_task_result(ok=True, callback={"remaining_sec": 38820, "action": "renewed"})
"""

from __future__ import annotations

import json
import os
from typing import Any, Mapping, MutableMapping, Optional


def _result_path() -> str:
    return (
        os.environ.get("TASK_RESULT_PATH")
        or os.environ.get("WORKER_RESULT_PATH")
        or ""
    ).strip()


def _read_existing(path: str) -> dict:
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def build_callback(
    remaining_sec: float | int,
    *,
    valid_until: str | None = None,
    action: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> dict:
    """Build the fixed callback object (no I/O)."""
    cb: dict[str, Any] = {
        "remaining_sec": float(remaining_sec),
    }
    if valid_until is not None and str(valid_until).strip():
        cb["valid_until"] = str(valid_until).strip()
    if action is not None and str(action).strip():
        cb["action"] = str(action).strip()
    if extra:
        for k, v in extra.items():
            if k in cb or v is None:
                continue
            cb[str(k)] = v
    return cb


def write_task_result(
    *,
    ok: bool = True,
    callback: Mapping[str, Any] | None = None,
    data: Mapping[str, Any] | None = None,
    error: str | None = None,
    merge: bool = True,
    path: str | None = None,
) -> Optional[str]:
    """Write / merge TASK_RESULT_PATH JSON. Returns path or None if unset."""
    result_path = (path or _result_path()).strip()
    if not result_path:
        return None

    payload: MutableMapping[str, Any] = _read_existing(result_path) if merge else {}
    payload["ok"] = bool(ok)
    if error is not None:
        payload["error"] = str(error)
    if data is not None:
        existing_data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        payload["data"] = {**existing_data, **dict(data)}
    if callback is not None:
        payload["callback"] = dict(callback)
        # Also flatten remaining_sec for robust panel parsers
        if "remaining_sec" in callback:
            payload["remaining_sec"] = callback["remaining_sec"]
        if callback.get("valid_until"):
            payload["valid_until"] = callback["valid_until"]
        if callback.get("action"):
            payload["action"] = callback["action"]

    parent = os.path.dirname(result_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return result_path


def report_remaining(
    remaining_sec: float | int,
    *,
    valid_until: str | None = None,
    action: str | None = None,
    ok: bool = True,
    extra: Mapping[str, Any] | None = None,
    path: str | None = None,
) -> Optional[str]:
    """Script-side fixed callback: always write remaining_sec when known.

    Panel decides whether to schedule from this (condition type remaining_callback).
    """
    cb = build_callback(
        remaining_sec,
        valid_until=valid_until,
        action=action,
        extra=extra,
    )
    return write_task_result(ok=ok, callback=cb, path=path)


def remaining_from_expiry(
    expiry_naive,
    *,
    now_naive=None,
) -> float:
    """expiry/now as naive datetime → remaining seconds (can be negative)."""
    from datetime import datetime, timezone

    if now_naive is None:
        now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    return (expiry_naive - now_naive).total_seconds()
