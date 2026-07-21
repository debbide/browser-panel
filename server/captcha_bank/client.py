# -*- coding: utf-8 -*-
"""
Optional external captcha-bank client (open, no secrets).

Configure via env (panel task / global env):
  CAPTCHA_BANK_URL      e.g. http://127.0.0.1:3920  (empty = disabled)
  CAPTCHA_BANK_TOKEN    Bearer token (optional but recommended)
  CAPTCHA_BANK_TIMEOUT_MS  default 2000
  CAPTCHA_BANK_MATCH    default 1
  CAPTCHA_BANK_RECORD   default 1

All network errors are swallowed → miss / no-op so open-source path never breaks.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional


def _truthy(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def enabled() -> bool:
    return bool((os.environ.get("CAPTCHA_BANK_URL") or "").strip())


def match_enabled() -> bool:
    return enabled() and _truthy("CAPTCHA_BANK_MATCH", True)


def record_enabled() -> bool:
    return enabled() and _truthy("CAPTCHA_BANK_RECORD", True)


def _base_url() -> str:
    return (os.environ.get("CAPTCHA_BANK_URL") or "").strip().rstrip("/")


def _timeout_sec() -> float:
    try:
        ms = float(os.environ.get("CAPTCHA_BANK_TIMEOUT_MS") or "2000")
    except Exception:
        ms = 2000.0
    return max(0.3, min(30.0, ms / 1000.0))


def _headers() -> Dict[str, str]:
    h = {"Content-Type": "application/json", "Accept": "application/json"}
    token = (os.environ.get("CAPTCHA_BANK_TOKEN") or "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _post(path: str, body: dict) -> Optional[dict]:
    url = f"{_base_url()}{path}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=_headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=_timeout_sec()) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            if not raw:
                return {}
            return json.loads(raw)
    except Exception as e:
        print(f"[captcha-bank] POST {path} failed: {e}", flush=True)
        return None


def normalize_object(obj: str) -> str:
    return str(obj or "").strip().lower()


def match(
    grid_image_path: str,
    target_object: str,
    tile_count: int,
    challenge_type: str = "",
) -> Optional[Dict[str, Any]]:
    """Return {sample_id, selected_tiles} or None."""
    if not match_enabled():
        return None
    path = (grid_image_path or "").strip()
    if not path or not os.path.isfile(path):
        return None
    payload = {
        "challenge_type": challenge_type or "",
        "target_object": normalize_object(target_object),
        "tile_count": int(tile_count),
        "grid_image_path": path,
    }
    res = _post("/v1/match", payload)
    if not res or not res.get("hit"):
        return None
    tiles = res.get("selected_tiles")
    if not isinstance(tiles, list) or not tiles:
        return None
    try:
        tiles_i = [int(x) for x in tiles]
    except Exception:
        return None
    sid = res.get("sample_id") or res.get("id") or ""
    print(
        f"[captcha-bank] HIT sample={sid} tiles={tiles_i} dist={res.get('distance')}",
        flush=True,
    )
    return {"sample_id": str(sid), "selected_tiles": tiles_i, "raw": res}


def record(
    grid_image_path: str,
    selected_tiles: List[int],
    target_object: str,
    tile_count: int,
    challenge_type: str = "",
    verify_ok: bool = True,
    instr_image_path: str = "",
    meta: Optional[dict] = None,
) -> Optional[str]:
    """Upload a sample; returns sample_id or None."""
    if not record_enabled():
        return None
    path = (grid_image_path or "").strip()
    if not path or not os.path.isfile(path):
        return None
    if not verify_ok:
        # still allow recording failures for human review if server wants
        pass
    payload = {
        "challenge_type": challenge_type or "",
        "target_object": normalize_object(target_object),
        "tile_count": int(tile_count),
        "selected_tiles": [int(x) for x in (selected_tiles or [])],
        "verify_ok": bool(verify_ok),
        "grid_image_path": path,
        "instr_image_path": (instr_image_path or "").strip() or None,
        "meta": meta or {},
    }
    res = _post("/v1/record", payload)
    if not res:
        return None
    sid = res.get("sample_id") or res.get("id")
    if sid:
        print(f"[captcha-bank] RECORD sample={sid} verify_ok={verify_ok}", flush=True)
    return str(sid) if sid else None


def report(sample_id: str, success: bool) -> None:
    if not enabled():
        return
    sid = (sample_id or "").strip()
    if not sid:
        return
    _post("/v1/report", {"sample_id": sid, "success": bool(success)})
    print(f"[captcha-bank] REPORT sample={sid} success={int(bool(success))}", flush=True)


# ---------------------------------------------------------------------------
# Dynamic captcha: tile (object crop) bank
# Match: small tile image + object name -> is this tile the object?
# Record: every selected tile crop + object name (human can fix later)
# ---------------------------------------------------------------------------


def tile_match(
    tile_image_path: str,
    target_object: str,
) -> Optional[Dict[str, Any]]:
    """Return {sample_id, is_positive, distance} if bank is confident, else None."""
    if not match_enabled():
        return None
    path = (tile_image_path or "").strip()
    if not path or not os.path.isfile(path):
        return None
    payload = {
        "target_object": normalize_object(target_object),
        "tile_image_path": path,
    }
    res = _post("/v1/tile/match", payload)
    if not res or not res.get("hit"):
        return None
    print(
        f"[captcha-bank] TILE HIT obj={normalize_object(target_object)} "
        f"pos={res.get('is_positive')} dist={res.get('distance')} id={res.get('sample_id')}",
        flush=True,
    )
    return res


def tile_record(
    tile_image_path: str,
    target_object: str,
    is_positive: bool = True,
    meta: Optional[dict] = None,
) -> Optional[str]:
    """Store one tile crop labeled as object (or not). Always for human review."""
    if not record_enabled():
        return None
    path = (tile_image_path or "").strip()
    if not path or not os.path.isfile(path):
        return None
    payload = {
        "target_object": normalize_object(target_object),
        "tile_image_path": path,
        "is_positive": bool(is_positive),
        "meta": meta or {},
    }
    res = _post("/v1/tile/record", payload)
    if not res:
        return None
    sid = res.get("sample_id") or res.get("id")
    if sid:
        print(
            f"[captcha-bank] TILE RECORD id={sid} obj={normalize_object(target_object)} "
            f"positive={int(bool(is_positive))}",
            flush=True,
        )
    return str(sid) if sid else None


def tile_report(sample_id: str, success: bool) -> None:
    if not enabled():
        return
    sid = (sample_id or "").strip()
    if not sid:
        return
    _post("/v1/tile/report", {"sample_id": sid, "success": bool(success)})
