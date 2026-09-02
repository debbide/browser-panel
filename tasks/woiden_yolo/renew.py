# -*- coding: utf-8 -*-
"""
Woiden renew business logic using Pyrogram native integration.
"""

import os
import time
import asyncio
import re
import random
import tempfile
from urllib.parse import urlparse

from pyrogram import Client

from woiden_yolo.browser import create_browser, close_browser, log

try:
    from woiden_yolo.logutil import (
        run_start,
        run_end,
        run_note,
        step_begin,
        step_end,
        phase as log_phase,
    )
except ImportError:
    def run_start(title="Woiden renew"):
        log(f"======== {title} START ========")

    def run_end(ok, reason=""):
        log(f"======== {'SUCCESS' if ok else 'FAIL'} {reason} ========")

    def run_note(note):
        if note:
            log(f"note: {note}")

    def step_begin(idx, total, name, detail=""):
        log(f"── [{idx}/{total}] {name} {detail}".strip())

    def step_end(name, ok, detail="", seconds=None):
        log(f"<<< {name} {'OK' if ok else 'FAIL'} {detail} {seconds or ''}".strip())

    def log_phase(label, msg, level="INFO"):
        log(f"[{label}] {msg}", level=level)

try:
    from woiden_yolo.browser import hide_ads as _hide_ads_impl
except ImportError:
    _hide_ads_impl = None

try:
    from woiden_yolo.captcha import handle_recaptcha_yolo
except ImportError:
    handle_recaptcha_yolo = None

try:
    # 轮次唯一解析点，见 woiden_yolo/captcha.py:resolve_yolo_max_rounds
    from woiden_yolo.captcha import resolve_yolo_max_rounds
except ImportError:
    # 独立 import：worker 树里 captcha.py 可能是旧版（没这个函数），
    # 不能让它把 handle_recaptcha_yolo 一起拖成 None。
    def resolve_yolo_max_rounds(default: int = 24) -> int:
        """Fallback resolver — env wins outright, no hard floor."""
        if not default or default <= 0:
            default = 24
        try:
            return max(1, int(os.environ.get("YOLO_RECAPTCHA_MAX_ROUNDS") or default))
        except Exception:
            return max(1, default)

try:
    from woiden_yolo.audio_captcha import solve_recaptcha_audio_then_yolo
except ImportError:
    solve_recaptcha_audio_then_yolo = None

try:
    from woiden_yolo.dom import is_recaptcha_solved
except ImportError:
    def is_recaptcha_solved(page):
        try:
            return bool(
                page.run_js(
                    "const t=document.querySelector('#g-recaptcha-response,textarea[name=\"g-recaptcha-response\"]');"
                    "return !!(t && t.value && t.value.length>20);"
                )
            )
        except Exception:
            return False


def hide_ads(page):
    """Scrub ad overlays (including Woiden content-lock interstitial)."""
    if _hide_ads_impl is not None:
        try:
            return _hide_ads_impl(page)
        except Exception as e:
            log(f"hide_ads impl failed: {e}", "WARN")
    # Fallback: minimal unlock-ad scrub if browser helper missing
    try:
        page.run_js(
            """
            document.querySelectorAll('div,section,aside,dialog').forEach(function(el){
              var t=((el.innerText||'')+'').toLowerCase();
              if(t.indexOf('unlock more content')>=0 || t.indexOf('view a short ad')>=0){
                el.style.setProperty('display','none','important');
                el.style.setProperty('pointer-events','none','important');
                try{el.remove();}catch(e){}
              }
            });
            """
        )
    except Exception:
        pass

# Button labels Telegram uses on OAuth / login confirmation messages
_ACCEPT_BUTTON_PATTERNS = (
    r"^\s*accept\s*$",
    r"^\s*confirm\s*$",
    r"^\s*allow\s*$",
    r"^\s*approve\s*$",
    r"^\s*yes\s*$",
    r"^\s*ok\s*$",
    r"同意",
    r"确认",
    r"允许",
    r"接受",
    r"授权",
)
_DECLINE_BUTTON_HINTS = ("decline", "cancel", "reject", "deny", "no", "拒绝", "取消", "否")
_LOGIN_HINTS = (
    "login", "log in", "sign in", "authorization", "authorisation",
    "confirm", "woiden.id", "loginwoidenbot", "loginhaxbot",
    "oauth", "web", "attempt", "request", "登录", "授权", "确认",
)


def _event_loop():
    try:
        return asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        return loop


async def get_latest_message_id(client, chat_id):
    """Return newest message id in chat, or 0."""
    try:
        async for msg in client.get_chat_history(chat_id, limit=1):
            return int(msg.id or 0)
    except Exception as e:
        log(f"Pyrogram: get_latest_message_id({chat_id}) failed: {e}", "WARN")
    return 0


async def wait_for_new_message(client, chat_id, pattern, timeout=60, check_interval=2, since_id=None):
    """Wait for a new message matching a regex pattern from a specific chat."""
    log(f"Pyrogram: Listening to chat {chat_id} for {timeout} seconds...")
    start_time = time.time()

    while time.time() - start_time < timeout:
        try:
            async for msg in client.get_chat_history(chat_id, limit=8):
                if since_id and msg.id <= since_id:
                    continue
                text = msg.text or msg.caption or ""
                if not text:
                    continue
                match = re.search(pattern, text, re.I)
                if match:
                    log(f"Pyrogram: Match found in message {msg.id}")
                    return match.group(1) if match.groups() else match.group(0), msg.id
        except Exception as e:
            log(f"Pyrogram polling error: {e}", "WARN")

        await asyncio.sleep(check_interval)

    return None, None


def _button_texts(msg):
    """Yield (kind, text, button) from reply markup. kind is inline|keyboard."""
    markup = getattr(msg, "reply_markup", None)
    if not markup:
        return
    inline = getattr(markup, "inline_keyboard", None) or []
    for row in inline:
        for btn in row or []:
            text = (getattr(btn, "text", None) or "").strip()
            if text:
                yield "inline", text, btn
    keyboard = getattr(markup, "keyboard", None) or []
    for row in keyboard:
        for btn in row or []:
            text = (getattr(btn, "text", None) or "").strip()
            if text:
                yield "keyboard", text, btn


def _is_accept_label(text):
    t = (text or "").strip()
    if not t:
        return False
    low = t.lower()
    if any(h in low for h in _DECLINE_BUTTON_HINTS):
        return False
    for pat in _ACCEPT_BUTTON_PATTERNS:
        if re.search(pat, t, re.I):
            return True
    return False


def _looks_like_login_confirm(msg):
    text = (msg.text or msg.caption or "" or "").lower()
    if any(h in text for h in _LOGIN_HINTS):
        return True
    for _, label, _btn in _button_texts(msg):
        if _is_accept_label(label):
            return True
        low = label.lower()
        if any(h in low for h in ("accept", "confirm", "allow", "同意", "确认", "允许")):
            return True
    return False


async def _click_accept_on_message(client, msg):
    """Click Accept/Confirm on a Telegram login confirmation message."""
    accept_labels = []
    for kind, label, btn in _button_texts(msg):
        if _is_accept_label(label):
            accept_labels.append((kind, label, btn))

    if not accept_labels:
        # Fallback: first non-decline button on a login-looking message
        for kind, label, btn in _button_texts(msg):
            low = label.lower()
            if any(h in low for h in _DECLINE_BUTTON_HINTS):
                continue
            accept_labels.append((kind, label, btn))
            break

    if not accept_labels:
        # Log what buttons we actually saw for debugging
        seen = [f"{k}:{t}" for k, t, _ in _button_texts(msg)]
        log(f"Pyrogram: msg {msg.id} has no Accept button; buttons={seen}", "WARN")
        return False

    kind, label, btn = accept_labels[0]
    log(f"Pyrogram: Clicking {kind} button {label!r} on msg {msg.id}")

    # 1) High-level click by text (works for inline + keyboard in recent Pyrogram)
    try:
        await msg.click(label)
        log(f"Pyrogram: msg.click({label!r}) ok")
        return True
    except Exception as e:
        log(f"Pyrogram: msg.click({label!r}) failed: {e}", "WARN")

    # 2) click by zero-based coordinates (row, col)
    try:
        markup = msg.reply_markup
        rows = getattr(markup, "inline_keyboard", None) or getattr(markup, "keyboard", None) or []
        for r_i, row in enumerate(rows):
            for c_i, b in enumerate(row or []):
                if (getattr(b, "text", None) or "").strip() == label:
                    await msg.click(r_i, c_i)
                    log(f"Pyrogram: msg.click({r_i},{c_i}) ok")
                    return True
    except Exception as e:
        log(f"Pyrogram: msg.click(row,col) failed: {e}", "WARN")

    # 3) Inline callback data
    data = getattr(btn, "callback_data", None)
    if data is not None:
        try:
            data_arg = data if isinstance(data, (bytes, str)) else str(data)
            await client.request_callback_answer(
                chat_id=msg.chat.id,
                message_id=msg.id,
                callback_data=data_arg,
            )
            log("Pyrogram: request_callback_answer ok")
            return True
        except Exception as e:
            log(f"Pyrogram: request_callback_answer failed: {e}", "WARN")

    # 4) URL button (rare for login confirm)
    url = getattr(btn, "url", None)
    if url:
        log(f"Pyrogram: Accept button is URL (cannot press via API): {url}", "WARN")

    return False


async def handle_oauth_confirmation(client, popup, since_ids=None, timeout=60):
    """After Continue on oauth.telegram.org:

    Current Telegram Login Widget flow (2024+): NO 5-digit code page.
    Telegram pushes a confirmation message to service chat 777000 with
    Accept / Decline. We must click Accept via the user API (Pyrogram).

    `since_ids` maps chat_id -> last seen message id before Continue was clicked.
    """
    since_ids = dict(since_ids or {})
    chats = [777000, "Telegram"]
    for c in chats:
        if c not in since_ids:
            since_ids[c] = await get_latest_message_id(client, c)

    log(
        f"Pyrogram: waiting for OAuth Accept on TG (not SMS/code) "
        f"timeout={timeout}s since={since_ids}"
    )
    start = time.time()
    accepted = False
    seen_msg_ids = set()

    while time.time() - start < timeout:
        for chat_id in chats:
            since = since_ids.get(chat_id, 0)
            try:
                async for msg in client.get_chat_history(chat_id, limit=12):
                    if since and msg.id <= since:
                        continue
                    if msg.id in seen_msg_ids:
                        continue
                    seen_msg_ids.add(msg.id)

                    text_preview = (msg.text or msg.caption or "")[:160].replace("\n", " ")
                    buttons = [f"{k}:{t}" for k, t, _ in _button_texts(msg)]
                    has_markup = bool(getattr(msg, "reply_markup", None))
                    log(
                        f"Pyrogram: new msg chat={chat_id} id={msg.id} "
                        f"markup={has_markup} buttons={buttons} text={text_preview!r}"
                    )

                    # Prefer messages that look like login confirm OR have any buttons
                    if not has_markup and not _looks_like_login_confirm(msg):
                        continue

                    if await _click_accept_on_message(client, msg):
                        accepted = True
                        since_ids[chat_id] = max(int(since_ids.get(chat_id, 0) or 0), msg.id)
                        break
                if accepted:
                    break
            except Exception as e:
                log(f"Pyrogram: history poll {chat_id} failed: {e}", "WARN")

        if accepted:
            # Give OAuth a moment to complete after Accept
            await asyncio.sleep(3)
            try:
                still_phone = popup.ele("#login-phone", timeout=0.5)
                still_code = popup.ele("#login-code", timeout=0.5)
                if not still_phone and not still_code:
                    log("OAuth form gone after Accept — success")
                    return True, "accept"
            except Exception:
                log("OAuth popup closed after Accept — success")
                return True, "accept-closed"

            # Form still there: wait a bit more, maybe page is transitioning
            log("Accept clicked; OAuth page still open, waiting...")
            await asyncio.sleep(2)
            try:
                body = (popup.ele("body", timeout=1).text or "").lower()
            except Exception:
                log("Popup gone after Accept wait — success")
                return True, "accept-closed"
            if any(x in body for x in ("incorrect", "invalid", "expired", "try again")):
                log(f"OAuth page error after Accept: {body[:160]!r}", "ERROR")
                return False, "accept-error"
            # Accept was pressed; treat remaining open page as soft success
            # (parent window often already received the auth callback)
            return True, "accept"

        await asyncio.sleep(1.5)

    log(
        "Pyrogram: never got OAuth Accept message. "
        "Check that the same TG account session is used, and that 777000 "
        "received a login confirmation after Continue.",
        "ERROR",
    )
    return False, "no-accept"

def wait_tg_login_widget(page, timeout=30):
    """Wait for Telegram Login Widget on Woiden login page.

    NOTE: This is NOT a Cloudflare challenge waiter. Older logs said
    "Waiting for Cloudflare..." which was misleading — the page often has
    no CF challenge; we only wait for the TG iframe/button to appear.
    """
    log(f"Waiting for Telegram login widget (up to {timeout}s)...")
    end = time.time() + timeout
    while time.time() < end:
        try:
            # Login widget is site-specific (Woiden); verification-code bot is shared with Hax.
            if (
                page.ele("#telegram-login-loginwoidenbot", timeout=0.5)
                or page.ele("#telegram-login-loginhaxbot", timeout=0.5)
                or page.ele("@src^https://oauth.telegram.org", timeout=0.5)
            ):
                log("Telegram login widget found")
                return True
        except Exception:
            pass
        # Real CF challenge markers (only log if actually present)
        try:
            title = ""
            try:
                title = page.title or ""
            except Exception:
                pass
            if page.ele("css:#challenge-form, .cf-browser-verification, iframe[src*='challenges.cloudflare']", timeout=0.2):
                log(f"Cloudflare challenge detected (title={title!r}), still waiting for widget...")
        except Exception:
            pass
        time.sleep(0.5)
    log("Telegram login widget not found before timeout", "WARN")
    return False


# backward-compatible alias (old name was misleading)
def pass_cloudflare(page):
    return wait_tg_login_widget(page, timeout=30)


# Longest-first so +886 wins over +88 / +8, +44 over +4, etc.
_COUNTRY_CODES = (
    "998", "996", "995", "994", "993", "992", "977", "976", "975", "974", "973", "972", "971", "970",
    "968", "967", "966", "965", "964", "963", "962", "961", "960", "886", "880", "856", "855", "853",
    "852", "850", "692", "691", "690", "689", "688", "687", "686", "685", "683", "682", "681", "680",
    "679", "678", "677", "676", "675", "674", "673", "672", "670", "599", "598", "597", "596", "595",
    "594", "593", "592", "591", "590", "509", "508", "507", "506", "505", "504", "503", "502", "501",
    "500", "423", "421", "420", "389", "387", "386", "385", "383", "382", "381", "380", "378", "377",
    "376", "375", "374", "373", "372", "371", "370", "359", "358", "357", "356", "355", "354", "353",
    "352", "351", "350", "299", "298", "297", "291", "290", "269", "268", "267", "266", "265", "264",
    "263", "262", "261", "260", "258", "257", "256", "255", "254", "253", "252", "251", "250", "249",
    "248", "246", "245", "244", "243", "242", "241", "240", "239", "238", "237", "236", "235", "234",
    "233", "232", "231", "230", "229", "228", "227", "226", "225", "224", "223", "222", "221", "220",
    "218", "216", "213", "212", "211", "98", "95", "94", "93", "92", "91", "90", "86", "84", "82",
    "81", "66", "65", "64", "63", "62", "61", "60", "58", "57", "56", "55", "54", "53", "52", "51",
    "49", "48", "47", "46", "45", "44", "43", "41", "40", "39", "36", "34", "33", "32", "31", "30",
    "27", "20", "7", "1",
)


def normalize_phone(raw):
    """Return E.164-ish '+<digits>' or empty string."""
    s = re.sub(r"[^\d+]", "", str(raw or "").strip())
    if not s:
        return ""
    if s.startswith("00"):
        s = "+" + s[2:]
    if not s.startswith("+"):
        s = "+" + s
    digits = re.sub(r"\D", "", s)
    return f"+{digits}" if digits else ""


def split_phone(raw):
    """Split full international phone into (country_code_digits, national_number).

    Telegram OAuth keeps country code and local number in two separate fields.
    """
    full = normalize_phone(raw)
    digits = re.sub(r"\D", "", full)
    if not digits:
        return "", ""

    for cc in _COUNTRY_CODES:
        if digits.startswith(cc) and len(digits) > len(cc):
            return cc, digits[len(cc):]

    # Fallback: assume last 10 digits are national (common for many countries)
    if len(digits) > 10:
        return digits[:-10], digits[-10:]
    return "", digits


def _find_country_code_input(popup, phone_input=None):
    """Locate Telegram OAuth country-code field.

    Real DOM (oauth.telegram.org):
      #login-phone-code   <- country dial code, e.g. +886
      #login-phone        <- national number
    """
    # Exact id from Telegram OAuth page — this is the left "+886" box
    for sel in (
        "#login-phone-code",
        "input#login-phone-code",
        "@id=login-phone-code",
        "css:#login-phone-code-textfield input",
        "css:.login_code_field_wrap input",
        "css:.login_phone_field_wrap input#login-phone-code",
    ):
        try:
            el = popup.ele(sel, timeout=1)
        except Exception:
            el = None
        if not el:
            continue
        try:
            eid = (el.attr("id") or "").lower()
            if phone_input and el == phone_input:
                continue
            if eid in {"login-phone", "login-code"}:
                continue
            return el
        except Exception:
            return el

    # Fallback: any tel input that is NOT the national number field
    try:
        for el in (popup.eles("css:input[type='tel']") or []):
            eid = (el.attr("id") or "").lower()
            if eid == "login-phone-code":
                return el
            if eid in {"login-phone", "login-code"}:
                continue
            if phone_input and el == phone_input:
                continue
            val = (el.value or el.attr("value") or "").strip()
            if re.fullmatch(r"\+?\d{1,4}", val or ""):
                return el
    except Exception:
        pass

    return None


def _read_input_value(el):
    try:
        return (el.value or el.attr("value") or "").strip()
    except Exception:
        try:
            return (el.attr("value") or "").strip()
        except Exception:
            return ""


def _js_set_input_by_id(popup, element_id, value):
    """Set an input by id with native value setter + input/change events.

    Telegram OAuth listens to real input events; plain el.value= often works
    here because these are plain form controls (not React controlled).
    Returns the value read back from the DOM, or None on failure.
    """
    try:
        return popup.run_js(
            """
            const id = arguments[0];
            const v = String(arguments[1] ?? '');
            const el = document.getElementById(id);
            if (!el) return null;
            el.focus();
            // Prefer native setter so frameworks that override value still update
            const proto = window.HTMLInputElement
              ? window.HTMLInputElement.prototype
              : null;
            const desc = proto
              ? Object.getOwnPropertyDescriptor(proto, 'value')
              : null;
            if (desc && desc.set) {
              desc.set.call(el, v);
            } else {
              el.value = v;
            }
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            el.dispatchEvent(new KeyboardEvent('keyup', {bubbles: true, key: '0'}));
            return el.value;
            """,
            element_id,
            value,
        )
    except Exception as e:
        log(f"JS set #{element_id} failed: {e}", "WARN")
        return None


def _set_phone_fields(popup, tg_phone):
    """Fill Telegram OAuth phone form: country code box + national number box.

    Real DOM (oauth.telegram.org):
      #login-country-wrap     country name dropdown
      #login-phone-code       left dial code input  (+44)
      #login-phone            national number input (no country digits)

    Important: set each field ONCE. Retrying +44 then 44 into a focused phone
    field produced trailing garbage like ...4444.
    """
    country_box = None
    phone_input = None
    for _ in range(20):
        try:
            country_box = popup.ele("#login-phone-code", timeout=0.5)
        except Exception:
            country_box = None
        try:
            phone_input = popup.ele("#login-phone", timeout=0.5)
        except Exception:
            phone_input = None
        if country_box and phone_input:
            break
        if country_box or phone_input:
            # one of them is enough to proceed after a short wait
            time.sleep(0.2)
            if not country_box:
                country_box = _find_country_code_input(popup, phone_input)
            if country_box and phone_input:
                break
        time.sleep(0.25)

    if not country_box:
        country_box = _find_country_code_input(popup, phone_input)

    if not phone_input:
        try:
            for el in (popup.eles("css:input[type='tel']") or []):
                if (el.attr("id") or "") == "login-phone-code":
                    country_box = country_box or el
                    continue
                phone_input = el
                break
        except Exception:
            pass

    if not phone_input:
        log("Could not find phone input (#login-phone) in popup.", "ERROR")
        return False

    cc, national = split_phone(tg_phone)
    if not national:
        log(f"Invalid phone number: {tg_phone!r}", "ERROR")
        return False

    # Guard: never put country digits into the national field
    national_digits = re.sub(r"\D", "", national)
    if cc and national_digits.startswith(cc) and len(national_digits) > len(cc):
        # already international without plus? strip cc again
        national_digits = national_digits[len(cc):]

    try:
        cb_id = country_box.attr("id") if country_box else None
        ph_id = phone_input.attr("id") if phone_input else None
    except Exception:
        cb_id, ph_id = "?", "?"
    log(
        f"Phone split: raw={tg_phone!r} country=+{cc or '?'} "
        f"national={national_digits} country_box_id={cb_id!r} phone_id={ph_id!r}"
    )

    # --- 1) country code: set EXACTLY once to +{cc} ---
    country_ok = False
    if country_box and cc:
        target_cc = f"+{cc}"
        # JS by id first — no keystrokes that can spill into the other field
        js_val = _js_set_input_by_id(popup, "login-phone-code", target_cc)
        time.sleep(0.25)
        val = _read_input_value(country_box)
        log(f"#login-phone-code after JS {target_cc!r}: dom={val!r} js_ret={js_val!r}")
        if re.sub(r"\D", "", val or "") == cc or re.sub(r"\D", "", str(js_val or "")) == cc:
            country_ok = True
        else:
            # single fallback: clear + input once (not +44 then 44)
            try:
                country_box.input(target_cc, clear=True)
            except Exception as e:
                log(f"country_box.input failed: {e}", "WARN")
            time.sleep(0.25)
            val = _read_input_value(country_box)
            log(f"#login-phone-code after .input {target_cc!r}: {val!r}")
            country_ok = re.sub(r"\D", "", val or "") == cc
    elif not country_box:
        log("Country code input #login-phone-code not found", "ERROR")

    # --- 2) national number: set EXACTLY once ---
    # If country box missing, fall back to full international digits in phone field.
    number_to_type = national_digits if (country_box and cc) else re.sub(
        r"\D", "", normalize_phone(tg_phone)
    )

    js_phone = _js_set_input_by_id(popup, "login-phone", number_to_type)
    time.sleep(0.25)
    phone_val = _read_input_value(phone_input)
    log(
        f"#login-phone after JS {number_to_type!r}: dom={phone_val!r} "
        f"js_ret={js_phone!r} country_ok={country_ok}"
    )

    phone_digits = re.sub(r"\D", "", phone_val or str(js_phone or ""))
    if phone_digits != number_to_type:
        try:
            phone_input.input(number_to_type, clear=True)
        except Exception as e:
            log(f"phone_input.input failed: {e}", "WARN")
        time.sleep(0.25)
        phone_val = _read_input_value(phone_input)
        phone_digits = re.sub(r"\D", "", phone_val or "")
        log(f"#login-phone after .input: {phone_val!r}")

    # Final sanitize: if national field accidentally contains trailing/extra cc digits, trim
    if cc and phone_digits != number_to_type:
        # e.g. 77689290694444 from double-typed 44
        if phone_digits.startswith(number_to_type) and phone_digits.endswith(cc * 2):
            fixed = number_to_type
            log(f"Stripping duplicated country tail from phone: {phone_digits} -> {fixed}", "WARN")
            _js_set_input_by_id(popup, "login-phone", fixed)
            phone_digits = fixed
        elif phone_digits.endswith(cc) and phone_digits[: -len(cc)] == number_to_type:
            fixed = number_to_type
            log(f"Stripping trailing country code from phone: {phone_digits} -> {fixed}", "WARN")
            _js_set_input_by_id(popup, "login-phone", fixed)
            phone_digits = fixed

    if country_box and cc and not country_ok:
        log(
            f"WARNING: country code field not updated to +{cc}; "
            f"still showing {_read_input_value(country_box)!r}",
            "WARN",
        )

    if phone_digits != number_to_type:
        log(
            f"WARNING: national number mismatch expect={number_to_type!r} got={phone_digits!r}",
            "WARN",
        )

    return True


def _page_url(page):
    try:
        return page.run_js("return location.href;") or ""
    except Exception:
        try:
            return getattr(page, "url", "") or ""
        except Exception:
            return ""


def is_on_login_page(page):
    u = (_page_url(page) or "").lower()
    return "/login" in u


def is_WOIDEN_logged_in(page):
    """Best-effort: not on /login and renew form or account nav visible."""
    u = (_page_url(page) or "").lower()
    if "/login" in u:
        return False
    try:
        if page.ele("#web_address", timeout=0.5) or page.ele("#form-submit", timeout=0.3):
            return True
    except Exception:
        pass
    try:
        # Logged-in nav often loses Login/Register or gains account links
        body = (page.ele("body", timeout=0.5).text or "").lower()
        if "log out" in body or "logout" in body or "extend vps" in body:
            # still weak if on public pages; combine with URL
            if "/login" not in u:
                return True
    except Exception:
        pass
    return "/login" not in u and bool(u)


def get_tg_widget_button(page, timeout=8):
    """Return (iframe, button, text) for Telegram login widget on Woiden login page."""
    end = time.time() + timeout
    while time.time() < end:
        iframe = None
        try:
            # Login widget = Woiden page; not the shared renew-code bot
            iframe = page.get_frame("#telegram-login-loginwoidenbot", timeout=0.8)
        except Exception:
            iframe = None
        if not iframe:
            try:
                iframe = page.get_frame("#telegram-login-loginhaxbot", timeout=0.5)
            except Exception:
                iframe = None
        if not iframe:
            try:
                iframe = page.get_frame("@src^https://oauth.telegram.org", timeout=1)
            except Exception:
                iframe = None
        if iframe:
            try:
                btn = iframe.ele(".tgme_widget_login_button", timeout=2) or iframe.ele(
                    "tag:button", timeout=1
                )
            except Exception:
                btn = None
            if btn:
                try:
                    text = (btn.text or "").strip()
                except Exception:
                    text = ""
                return iframe, btn, text
        time.sleep(0.4)
    return None, None, ""


def click_tg_widget_and_wait_login(page, btn=None, wait_sec=12):
    """Click Telegram widget button and wait until we leave /login if possible."""
    if btn is None:
        _iframe, btn, text = get_tg_widget_button(page, timeout=5)
        log(f"Widget click target text={text!r}")
    if not btn:
        return False
    try:
        btn.click()
    except Exception:
        try:
            page.run_js("arguments[0].click();", btn)
        except Exception as e:
            log(f"Widget click failed: {e}", "ERROR")
            return False

    # Widget may open oauth popup that auto-closes when session is warm
    end = time.time() + wait_sec
    while time.time() < end:
        # Close stray oauth tabs if any
        try:
            # if we left login page, good
            if not is_on_login_page(page):
                log(f"Left login page after widget click → {_page_url(page)!r}")
                return True
        except Exception:
            pass
        # Confirm on 777000 may still be needed for first-time; caller handles phone path
        time.sleep(0.5)

    # Still on login — maybe need Confirm via API already done; try navigate home
    log(f"Still on login after widget click url={_page_url(page)!r}", "WARN")
    return not is_on_login_page(page)


def _fast_goto(page, url, ready_selectors, label="", timeout_sec=25):
    """Navigate without blocking on full page load (ads/analytics keep page.get hanging).

    Prefer location.assign / location.href, then poll for a ready selector.
    Falls back to page.get only if JS navigation is unavailable.
    Returns True if any ready_selector appears (or URL already matches and form found).
    """
    label = label or url
    ready_selectors = tuple(s for s in (ready_selectors or ()) if s)
    cur = (_page_url(page) or "").strip()
    # Already on target with form? skip navigation
    if url.rstrip("/") in cur.rstrip("/") or cur.rstrip("/").endswith(urlparse(url).path.rstrip("/")):
        for sel in ready_selectors:
            try:
                if page.ele(sel, timeout=0.4):
                    log(f"{label}: already ready ({sel}) url={cur!r}")
                    return True
            except Exception:
                pass

    log(f"Go {url} (fast path, no full page.get wait)")
    navigated = False
    for js in (
        f"location.assign({url!r});",
        f"location.href={url!r};",
    ):
        try:
            page.run_js(js)
            navigated = True
            break
        except Exception as e:
            log(f"fast nav js failed: {e}", "WARN")

    if not navigated:
        # last resort — can hang 1–2 min on this site via proxy
        log(f"{label}: fallback page.get (may be slow)", "WARN")
        try:
            # shorten load wait if DP supports it
            try:
                page.set.timeouts(page_load=12)
            except Exception:
                pass
            page.get(url)
            navigated = True
        except Exception as e:
            log(f"open {url} failed: {e}", "ERROR")
            return False

    # Poll for form / ready markers instead of sleeping blindly
    t0 = time.time()
    last_beat = 0
    while time.time() - t0 < max(5, int(timeout_sec)):
        hide_ads(page)
        url_now = _page_url(page)
        if "login" in (url_now or "").lower() and "vps-renew" in url:
            # bounced to login — caller handles TG login
            log(f"{label}: bounced to login url={url_now!r}")
            return False
        for sel in ready_selectors:
            try:
                if page.ele(sel, timeout=0.35):
                    elapsed = time.time() - t0
                    log(f"{label}: ready via {sel!r} in {elapsed:.1f}s url={url_now!r}")
                    hide_ads(page)
                    return True
            except Exception:
                pass
        elapsed = time.time() - t0
        if elapsed - last_beat >= 5:
            log(f"… waiting {label} ({elapsed:.0f}s) url={url_now!r}")
            last_beat = elapsed
        time.sleep(0.45)

    url_now = _page_url(page)
    log(f"{label}: not ready within {timeout_sec}s url={url_now!r}", "WARN")
    # If URL is correct but selectors late, let caller decide
    return "vps-renew" in (url_now or "").lower() and "login" not in (url_now or "").lower()


def go_vps_renew(page):
    """Navigate straight to renew page. Returns True if form is usable.

    IMPORTANT: Do NOT use bare page.get() here — on Woiden via proxy it often
    sits 1–2 minutes after the document is already interactive (ads/CF/pixels).
    Use fast JS navigation + poll #web_address / #form-submit.
    """
    ok = _fast_goto(
        page,
        "https://woiden.id/vps-renew",
        ready_selectors=("#web_address", "#form-submit", "css:input[name='web_address']"),
        label="vps-renew",
        timeout_sec=int(os.environ.get("WOIDEN_VPS_RENEW_NAV_TIMEOUT", "30")),
    )
    hide_ads(page)
    url = _page_url(page)
    log(f"vps-renew URL: {url!r}")
    if "login" in (url or "").lower():
        return False
    if page.ele("#web_address", timeout=1.5) or page.ele("#form-submit", timeout=0.8):
        return True
    if ok:
        return wait_for_renew_form(page, timeout=8)
    return wait_for_renew_form(page, timeout=5)


def ensure_WOIDEN_site_session(page, client, tg_phone):
    """After TG OAuth, land on /vps-renew. No dashboard/login sightseeing.

    Desired path:
      OAuth done → open /vps-renew → if form OK, stop.
      If bounced to /login → click Log in as / phone flow remnant → /vps-renew again.
    """
    log("Ensuring session by opening /vps-renew directly...")
    if go_vps_renew(page):
        log("Woiden site session OK — already on renew form")
        return True

    # Bounced or not logged in: one chance via login widget
    log("Not on renew form — need Log-in-as click on /login once")
    try:
        page.get("https://woiden.id/login")
    except Exception:
        pass
    time.sleep(1.5)
    hide_ads(page)
    # Wait widget only (NOT cloudflare challenge) — short
    wait_tg_login_widget(page, timeout=15)

    _iframe, btn, text = get_tg_widget_button(page, timeout=10)
    log(f"Login widget text: {text!r}")
    if btn and ("Log in as" in text or (text and text != "Log in with Telegram")):
        log(f"Clicking: {text!r}")
        click_tg_widget_and_wait_login(page, btn=btn, wait_sec=12)
        if is_on_login_page(page):
            loop = _event_loop()
            since = {777000: loop.run_until_complete(get_latest_message_id(client, 777000))}
            try:
                try:
                    popup = page.get_tab(page.latest_tab)
                except Exception:
                    popup = page
                ok, how = loop.run_until_complete(
                    handle_oauth_confirmation(
                        client, popup, since_ids=since,
                        timeout=int(os.environ.get("WOIDEN_OAUTH_CONFIRM_TIMEOUT", "40")),
                    )
                )
                log(f"Log-in-as Confirm path={how} ok={ok}")
            except Exception as e:
                log(f"Log-in-as Confirm failed: {e}", "WARN")

    # Always finish on renew page
    if go_vps_renew(page):
        log("Woiden site session OK — renew form visible")
        return True

    url = _page_url(page)
    log(f"Still not on renew form (url={url!r})", "ERROR")
    return False


def login_woiden(page, client, tg_phone):
    """Establish woiden.id session.

    Two login modes on /login (both already implemented below):
      A) Cookie warm: Telegram widget shows "Log in as NAME" → one click (+ optional TG Confirm)
      B) No cookie / session dead: "Log in with Telegram" → phone OAuth (country+number+Continue+Confirm)

    Order:
      1) Probe /vps-renew — if form OK, already logged in (skip TG entirely)
      2) Else open /login and pick A or B from widget button text
    """
    # ---- 1) Session probe FIRST (cookie already saved in profile) ----
    log("Login check: probe /vps-renew first (skip TG if already logged in)")
    # If already sitting on /login, don't waste time probing renew first
    if not is_on_login_page(page):
        if go_vps_renew(page):
            log("Already logged in — renew form visible, skip Telegram login")
            return True
    else:
        log(f"Already on login page url={_page_url(page)!r} — TG login")

    # Not on renew form: see if we are on login / redirected
    url = _page_url(page)
    log(f"Not logged in yet (after probe url={url!r}) — need Telegram login")

    # ---- 2) Telegram login only when needed ----
    if not is_on_login_page(page):
        log("Navigating to https://woiden.id/login")
        try:
            page.run_js("location.assign('https://woiden.id/login');")
            time.sleep(2)
        except Exception:
            try:
                page.get("https://woiden.id/login")
            except Exception as e:
                log(f"open /login failed: {e}", "ERROR")
                return False
    else:
        log("Stay on /login (already there)")

    # Wait for TG widget only when we actually need to log in
    if not wait_tg_login_widget(page, timeout=30):
        # Maybe cookie worked mid-way — probe renew again before failing
        if go_vps_renew(page):
            log("Logged in during widget wait — continue")
            return True
        log("Telegram login widget not ready and still not logged in", "ERROR")
        return False

    hide_ads(page)

    iframe, btn, btn_text = get_tg_widget_button(page, timeout=15)
    if not iframe or not btn:
        # Last chance: already logged in?
        if go_vps_renew(page):
            log("No TG widget but renew form OK — treat as logged in")
            return True
        log("Cannot find Telegram login widget iframe/button!", "ERROR")
        try:
            html_path = "/tmp/Woiden-fail-html.txt"
            with open(html_path, "w", encoding="utf-8") as f:
                f.write(page.html)
            log(f"Saved failed page HTML to {html_path}")
        except Exception as e:
            log(f"Failed to save HTML: {e}")
        return False

    try:
        log(f"Widget button text: {btn_text}")

        # Warm TG session: "Log in as NAME" — must click to create Woiden session
        if "Log in as" in btn_text or (btn_text and btn_text != "Log in with Telegram"):
            log("Session is alive on TG. Clicking Auto-Login to enter Woiden...")
            click_tg_widget_and_wait_login(page, btn=btn, wait_sec=12)
            # Confirm may be required even for Log-in-as
            if is_on_login_page(page):
                loop = _event_loop()
                since_ids = {
                    777000: loop.run_until_complete(get_latest_message_id(client, 777000)),
                }
                try:
                    popup = page.get_tab(page.latest_tab)
                except Exception:
                    popup = page
                time.sleep(1)
                ok, how = loop.run_until_complete(
                    handle_oauth_confirmation(
                        client,
                        popup,
                        since_ids=since_ids,
                        timeout=int(os.environ.get("WOIDEN_OAUTH_CONFIRM_TIMEOUT", "45")),
                    )
                )
                log(f"Auto-login Confirm path={how} ok={ok}")
            return ensure_WOIDEN_site_session(page, client, tg_phone)

        log("Session expired. Attempting phone login...")
        btn.click()

        time.sleep(3)
        popup = page.get_tab(page.latest_tab)

        if not _set_phone_fields(popup, tg_phone):
            return False

        # Real DOM:
        #   Cancel  -> button[type=button].button-item-flat  (onclick=loginCancel)
        #   Continue -> button[type=submit].button-item     (label in span.button-item-label)
        # Never fall back to bare tag:button — that matches Cancel first.
        submit_btn = None
        for sel in (
            "css:#send-form button[type='submit']",
            "css:form#send-form button[type='submit']",
            "css:form.login_form button[type='submit']",
            "css:button[type='submit']",
            "tag:button@type=submit",
            "css:.login_button_wrap button[type='submit']",
            "tag:button:contains(Continue)",
            "tag:button:contains(CONTINUE)",
        ):
            try:
                el = popup.ele(sel, timeout=1)
            except Exception:
                el = None
            if not el:
                continue
            label = (el.text or "").strip().lower()
            btn_type = (el.attr("type") or "").lower()
            cls = (el.attr("class") or "").lower()
            # Hard reject Cancel / flat cancel button
            if "cancel" in label or "loginCancel" in (el.attr("onclick") or ""):
                log(f"Skip cancel-like button via {sel!r}: {label!r}", "WARN")
                continue
            if "button-item-flat" in cls and btn_type != "submit":
                continue
            if btn_type == "submit" or "continue" in label or "next" in label:
                submit_btn = el
                log(f"Resolved Continue button via {sel!r}: text={label!r} type={btn_type!r}")
                break

        # Snapshot newest 777000 message id BEFORE Continue, so we only react to new ones
        loop = _event_loop()
        since_ids = {
            777000: loop.run_until_complete(get_latest_message_id(client, 777000)),
        }
        try:
            since_ids["Telegram"] = loop.run_until_complete(
                get_latest_message_id(client, "Telegram")
            )
        except Exception:
            pass
        log(f"Pyrogram: pre-Continue since_ids={since_ids}")

        if submit_btn:
            log(f"Clicking submit: {(submit_btn.text or '').strip()!r}")
            try:
                submit_btn.click()
            except Exception as e:
                log(f"submit click failed: {e}, try form requestSubmit", "WARN")
                try:
                    popup.run_js(
                        """
                        const form = document.getElementById('send-form');
                        if (form && form.requestSubmit) { form.requestSubmit(); return 'requestSubmit'; }
                        if (form) { form.submit(); return 'submit'; }
                        return 'no-form';
                        """
                    )
                except Exception as e2:
                    log(f"form submit failed: {e2}", "ERROR")
                    return False
        else:
            log("Continue button not found, try form requestSubmit / Enter", "WARN")
            submitted = None
            try:
                submitted = popup.run_js(
                    """
                    const form = document.getElementById('send-form');
                    if (form && form.requestSubmit) { form.requestSubmit(); return 'requestSubmit'; }
                    if (form) { form.submit(); return 'submit'; }
                    return null;
                    """
                )
            except Exception as e:
                log(f"JS form submit failed: {e}", "WARN")
            if not submitted:
                phone_input = popup.ele("#login-phone", timeout=1)
                if phone_input:
                    try:
                        phone_input.input("\n")
                    except Exception:
                        try:
                            popup.run_js(
                                "const el=document.getElementById('login-phone');"
                                "if(el){el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,keyCode:13}));}"
                            )
                        except Exception:
                            pass
                else:
                    log("No Continue button and no phone input to press Enter", "ERROR")
                    return False

        # --- PYROGRAM: click Accept on TG login confirmation (no 5-digit code path) ---
        time.sleep(1.5)
        ok, how = loop.run_until_complete(
            handle_oauth_confirmation(
                client,
                popup,
                since_ids=since_ids,
                timeout=int(os.environ.get("WOIDEN_OAUTH_CONFIRM_TIMEOUT", "60")),
            )
        )
        if not ok:
            log(f"Pyrogram: OAuth Accept failed ({how})", "ERROR")
            return False

        log(f"OAuth accepted via TG API path={how}; completing Woiden site login...")
        # Critical: TG Accept alone is NOT enough. Must land a Woiden session cookie
        # by clicking "Log in as …" / waiting for callback. Otherwise Renew → /login.
        return ensure_WOIDEN_site_session(page, client, tg_phone)

    except Exception as e:
        log(f"Telegram widget error: {e}", "ERROR")
        try:
            with open("/tmp/Woiden-fail-iframe.txt", "w", encoding="utf-8") as f:
                f.write(iframe.inner_html)
        except Exception:
            pass
        return False


def wait_for_renew_form(page, timeout=30):
    """Wait until the vps-renew form is present."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            if page.ele("#web_address", timeout=1) or page.ele("#form-submit", timeout=0.5):
                return True
        except Exception:
            pass
        # May still be behind CF challenge on renew page
        time.sleep(1)
    return False


def page_has_turnstile(page) -> bool:
    """True only when a Cloudflare Turnstile widget is actually on the page.

    Woiden /vps-renew currently uses image math captcha (#captcha) instead of CF.
    """
    try:
        return bool(
            page.run_js(
                """
                return !!(
                  document.querySelector('.cf-turnstile')
                  || document.querySelector('iframe[src*="challenges.cloudflare"]')
                  || document.querySelector('iframe[src*="turnstile"]')
                  || document.querySelector('input[name="cf-turnstile-response"]')
                  || document.querySelector('textarea[name="cf-turnstile-response"]')
                );
                """
            )
        )
    except Exception:
        return False


def page_has_math_captcha(page) -> bool:
    """True when renew form has #captcha (image math on Woiden /vps-renew)."""
    try:
        return bool(
            page.ele("#captcha", timeout=0.8)
            or page.ele("css:input[name='captcha']", timeout=0.5)
            or page.run_js(
                "return !!(document.getElementById('captcha')"
                "|| document.querySelector(\"input[name='captcha']\"));"
            )
        )
    except Exception:
        return False


def fill_renew_form(page, website=None):
    """Fill #web_address and check agreement checkbox.

    Real DOM (woiden.id/vps-renew):
      input#web_address[name=web_address]
      input#captcha[name=captcha]   # image math (img op img) — solved separately
      input[name=agreement][value=yes]
      button[name=submit_button]  Renew VPS
      (no Cloudflare Turnstile on current Woiden renew page)

    Always REPLACE the value (never append). Previous bug:
      clear failed → input() appended → 'woiden.idwoiden.id'
    """
    website = (website or os.environ.get("WOIDEN_WEB_ADDRESS") or "woiden.id").strip()
    website = re.sub(r"^https?://", "", website).strip().strip("/")
    # Collapse accidental double paste
    if website.count("woiden.id") > 1:
        website = "woiden.id"

    web_input = (
        page.ele("#web_address", timeout=8)
        or page.ele("@name=web_address", timeout=2)
        or page.ele("css:input[name='web_address']", timeout=2)
    )
    if not web_input:
        log("Renew form: #web_address not found", "ERROR")
        return False

    # Force an exact value. This function is called repeatedly by retry paths,
    # so a failed clear must never be followed by typing that appends another
    # copy of the domain.
    try:
        try:
            web_input.scroll.to_see()
            time.sleep(random.uniform(0.3, 0.7))
            web_input.hover()
            time.sleep(random.uniform(0.2, 0.5))
            web_input.click()
            time.sleep(random.uniform(0.1, 0.3))
        except Exception:
            pass

        # Use native input with clear first, then verify the DOM. Some
        # DrissionPage/element states silently fail to clear during navigation.
        web_input.input(website, clear=True)
        val = _read_input_value(web_input)

        if val != website:
            log(
                f"Renew form: native replace mismatch expect={website!r} got={val!r}; "
                "forcing exact value",
                "WARN",
            )
            forced = page.run_js(
                """
                const el = arguments[0];
                const value = String(arguments[1] || '');
                if (!el) return null;
                const setter = Object.getOwnPropertyDescriptor(
                  HTMLInputElement.prototype, 'value'
                );
                if (setter && setter.set) setter.set.call(el, value);
                else el.value = value;
                el.dispatchEvent(new Event('input', {bubbles: true}));
                el.dispatchEvent(new Event('change', {bubbles: true}));
                return el.value;
                """,
                web_input,
                website,
            )
            val = str(forced or _read_input_value(web_input)).strip()

        if val != website:
            log(
                f"Renew form: refusing submit because #web_address is not exact: "
                f"expect={website!r} got={val!r}",
                "ERROR",
            )
            return False

        log(f"Renew form: #web_address replaced exactly → {val!r}")
    except Exception as e:
        log(f"Native set #web_address failed: {e}", "ERROR")
        return False
    log(f"Renew form: #web_address = {val!r}")

    # Checkbox: name=agreement value=yes
    checkbox = (
        page.ele("css:input[name='agreement']", timeout=3)
        or page.ele("@name=agreement", timeout=1)
        or page.ele("css:input.form-check-input[type='checkbox']", timeout=1)
    )
    if not checkbox:
        log("Renew form: agreement checkbox not found", "ERROR")
        return False

    checked = False
    try:
        checked = bool(checkbox.states.is_checked)
    except Exception:
        try:
            checked = bool(
                page.run_js(
                    "const el=document.querySelector(\"input[name='agreement']\");"
                    "return !!(el && el.checked);"
                )
            )
        except Exception:
            checked = False

    if not checked:
        log("Renew form: checking agreement checkbox...")
        clicked = False
        for clicker in (
            lambda: checkbox.click(),
            lambda: page.ele("css:label.form-check-label", timeout=1).click(),
            lambda: page.ele("tag:label:contains(Please Renew my server)", timeout=1).click(),
            lambda: page.run_js(
                "const el=document.querySelector(\"input[name='agreement']\");"
                "if(el){el.checked=true;"
                "el.dispatchEvent(new Event('input',{bubbles:true}));"
                "el.dispatchEvent(new Event('change',{bubbles:true}));"
                "return el.checked;}"
            ),
        ):
            try:
                clicker()
                clicked = True
                break
            except Exception:
                continue
        if not clicked:
            log("Renew form: failed to check agreement", "ERROR")
            return False
        time.sleep(0.3)
    else:
        log("Renew form: agreement already checked")

    try:
        is_on = page.run_js(
            "const el=document.querySelector(\"input[name='agreement']\");"
            "return !!(el && el.checked);"
        )
    except Exception:
        is_on = True
    log(f"Renew form: agreement checked={is_on}")
    return True


def turnstile_token_present(page):
    try:
        return bool(
            page.run_js(
                """
                const i = document.querySelector('input[name="cf-turnstile-response"]')
                       || document.querySelector('textarea[name="cf-turnstile-response"]');
                return !!(i && i.value && i.value.length > 20);
                """
            )
        )
    except Exception:
        return False


def turnstile_token_len(page):
    try:
        return int(
            page.run_js(
                """
                const i = document.querySelector('input[name="cf-turnstile-response"]')
                       || document.querySelector('textarea[name="cf-turnstile-response"]');
                return i && i.value ? i.value.length : 0;
                """
            )
            or 0
        )
    except Exception:
        return 0


def turnstile_success_visible(page):
    """Detect Turnstile finished in UI.

    ONLY trust explicit success text / data-state / iframe title.
    Do NOT use green-color heuristics — ads/nav false-trigger constantly
    (see logs: check=True with text=False class=False while token empty).
    """
    try:
        info = page.run_js(
            """
            function visible(el) {
              if (!el) return false;
              const st = window.getComputedStyle(el);
              if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
              if (parseFloat(st.opacity || '1') < 0.1) return false;
              const r = el.getBoundingClientRect();
              return r.width > 2 && r.height > 2;
            }
            const out = {
              successText: false,
              successClass: false,
              iframeTitle: '',
              nearWidget: '',
              tokenLen: 0,
            };
            const ts = document.querySelector(
              'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
            );
            out.tokenLen = ts && ts.value ? ts.value.length : 0;

            const roots = [];
            const w = document.querySelector('.cf-turnstile');
            if (w) {
              roots.push(w);
              if (w.parentElement) roots.push(w.parentElement);
            }
            // Do NOT scan whole form/body — "success" words elsewhere false-positive
            const blob = roots.map(r => (r.innerText || r.textContent || '')).join(' | ');
            out.nearWidget = blob.slice(0, 120);
            // Require Chinese 成功 near widget, or clear verified phrases
            if (/成功\\s*!|验证通过|已验证|验证成功/.test(blob)) {
              out.successText = true;
            }

            const sels = [
              '.cf-turnstile[data-state="success"]',
              '.cf-turnstile.success',
              '.cf-turnstile [data-state="success"]',
            ];
            for (const sel of sels) {
              const el = document.querySelector(sel);
              if (el && visible(el)) { out.successClass = true; break; }
            }

            const ifr = document.querySelector(
              '.cf-turnstile iframe, iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]'
            );
            if (ifr) {
              out.iframeTitle = (ifr.getAttribute('title') || ifr.getAttribute('aria-label') || '').slice(0, 80);
              if (/success|完成|成功/i.test(out.iframeTitle)) out.successText = true;
            }
            out.ok = !!(out.successText || out.successClass);
            return out;
            """
        )
        if isinstance(info, dict) and info.get("ok"):
            log(
                f"Turnstile UI success markers: "
                f"text={info.get('successText')} class={info.get('successClass')} "
                f"title={info.get('iframeTitle')!r} tokenLen={info.get('tokenLen')}"
            )
            return True
        if isinstance(info, dict):
            # useful debug without claiming success
            return False
    except Exception as e:
        log(f"turnstile UI probe failed: {e}", "WARN")
    return False


def wait_turnstile_ready(page, timeout=90, prefer_ui_success=True):
    """Wait for Turnstile only when the widget exists.

    Woiden /vps-renew currently uses image math captcha instead of CF.
    If no Turnstile DOM is present, return True immediately so renew can
    continue via the Vision math path.
    """
    if not page_has_turnstile(page):
        log("No Turnstile on page — skip CF wait (math captcha path)")
        return True

    # How long token must stay stable after first appearing
    settle_sec = float(os.environ.get("WOIDEN_TURNSTILE_SETTLE_SEC") or "8")
    min_token_len = int(os.environ.get("WOIDEN_TURNSTILE_MIN_TOKEN_LEN") or "200")
    # require_ui=1 only accepts explicit UI; default 0 = token-stable is enough
    require_ui = str(os.environ.get("WOIDEN_TURNSTILE_REQUIRE_UI", "0")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if prefer_ui_success is False:
        require_ui = False

    log(
        f"Waiting for Cloudflare Turnstile (up to {timeout}s, "
        f"token_settle={settle_sec}s, min_len={min_token_len}, require_ui={int(require_ui)})..."
    )
    end = time.time() + max(20, int(timeout))
    last_log = 0
    token_seen_at = 0
    last_token_len = 0
    stable_token_since = 0

    while time.time() < end:
        tlen = turnstile_token_len(page)
        token_ok = tlen >= min_token_len
        ui_ok = turnstile_success_visible(page)

        if ui_ok and token_ok:
            time.sleep(0.8)
            if turnstile_token_len(page) >= min_token_len:
                log(f"Turnstile ready token=True(len={tlen}) ui_success=True")
                return True

        if token_ok:
            if not token_seen_at:
                token_seen_at = time.time()
                last_token_len = tlen
                stable_token_since = token_seen_at
                log(
                    f"Turnstile token present (len={tlen}); "
                    f"stabilize {settle_sec}s before click"
                )
            else:
                if tlen != last_token_len:
                    last_token_len = tlen
                    stable_token_since = time.time()
                    log(f"Turnstile token changed len={tlen} — still settling")

            waited = time.time() - token_seen_at
            stable_for = time.time() - stable_token_since

            if require_ui:
                if not ui_ok and waited >= max(settle_sec, 20) and stable_for >= 3.0:
                    # still no scrapeable UI after long stable token — accept token
                    log(
                        f"Turnstile UI not scrapeable but token stable "
                        f"len={tlen} for {stable_for:.1f}s — proceed",
                        "WARN",
                    )
                    return True
            else:
                if stable_for >= settle_sec:
                    time.sleep(0.6)
                    # re-check still long
                    t2 = turnstile_token_len(page)
                    if t2 >= min_token_len:
                        log(
                            f"Turnstile ready token=True(len={t2}) "
                            f"ui_success={ui_ok} stable={stable_for:.1f}s"
                        )
                        return True
        elif tlen > 0:
            # short placeholder — not ready
            if time.time() - last_log > 8:
                log(f"Turnstile short token len={tlen} (<{min_token_len}) — wait")
                last_log = time.time()

        now = time.time()
        if now - last_log > 8:
            log(
                f"Turnstile still pending token={token_ok} ui={ui_ok} "
                f"len={tlen} "
                f"waited={((now - token_seen_at) if token_seen_at else 0):.0f}s..."
            )
            last_log = now
        time.sleep(0.6)

    tlen = turnstile_token_len(page)
    ui_ok = turnstile_success_visible(page)
    if tlen >= min_token_len:
        log(
            f"Turnstile timeout but long token present len={tlen} ui={ui_ok} — proceed",
            "WARN",
        )
        return True
    log(f"Turnstile not ready before timeout (len={tlen} ui={ui_ok})", "ERROR")
    return False


def refresh_turnstile(page):
    """Force Turnstile to re-render / clear stale token."""
    try:
        page.run_js(
            """
            try {
              const el = document.querySelector('.cf-turnstile');
              const inp = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
              if (inp) inp.value = '';
              if (window.turnstile && el) {
                try { window.turnstile.reset(el); } catch (e1) {
                  try { window.turnstile.remove(el); } catch (e2) {}
                  try { window.turnstile.render(el); } catch (e3) {}
                }
                return 'reset';
              }
              // hard reload widget container
              if (el && el.parentNode) {
                const html = el.outerHTML;
                const parent = el.parentNode;
                el.remove();
                parent.insertAdjacentHTML('beforeend', html);
                return 'rerender-html';
              }
            } catch (e) { return String(e); }
            return 'noop';
            """
        )
        log("Turnstile refresh attempted")
    except Exception as e:
        log(f"Turnstile refresh failed: {e}", "WARN")
    time.sleep(2)


def _form_preflight(page):
    """Ensure website + agreement (+ optional math captcha) look valid before Renew."""
    try:
        state = page.run_js(
            """
            const web = document.getElementById('web_address');
            const agr = document.querySelector("input[name='agreement']");
            const cap = document.getElementById('captcha')
                     || document.querySelector("input[name='captcha']");
            const ts  = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
            const form = document.getElementById('form-submit');
            // force-check agreement if still off
            if (agr && !agr.checked) {
              agr.checked = true;
              agr.dispatchEvent(new Event('input', {bubbles:true}));
              agr.dispatchEvent(new Event('change', {bubbles:true}));
            }
            if (web && !(web.value || '').trim()) {
              web.value = 'woiden.id';
              web.dispatchEvent(new Event('input', {bubbles:true}));
              web.dispatchEvent(new Event('change', {bubbles:true}));
            }
            return {
              web: web ? (web.value || '') : null,
              agreement: agr ? !!agr.checked : null,
              captcha: cap ? String(cap.value || '').trim() : null,
              hasCaptchaInput: !!cap,
              turnstileLen: ts && ts.value ? ts.value.length : 0,
              formDisplay: form ? (getComputedStyle(form).display || '') : null,
              formAction: form ? (form.getAttribute('action') || form.action || '') : null,
            };
            """
        )
        log(f"Renew preflight: {state!r}")
        if isinstance(state, dict):
            if not state.get("agreement"):
                log("Agreement still unchecked after force", "WARN")
            if state.get("hasCaptchaInput") and not state.get("captcha"):
                log("Math captcha #captcha empty before Renew click", "WARN")
            if page_has_turnstile(page) and int(state.get("turnstileLen") or 0) < 20:
                log("Turnstile token missing/short — submit may silently fail", "WARN")
        return state
    except Exception as e:
        log(f"Renew preflight failed: {e}", "WARN")
        return None


def click_renew_button(page):
    """Click the blue Renew VPS button (type=button name=submit_button).

    Woiden button is type=button with site JS/AJAX — NOT a normal form submit.
    NEVER call form.submit() / requestSubmit(): that bypasses their handler and
    leaves #response empty forever (regression after multi-strategy spam).

    Math captcha path: ONE slow click only. Chaining js+native+mouse in ~2s
    re-fires submit and often yields "Please solve Captcha correctly!" even when
    the answer was right.
    """
    _form_preflight(page)
    math_mode = False

    if page_has_turnstile(page):
        tlen = turnstile_token_len(page)
        log(f"Renew click precheck turnstileLen={tlen}")
        if tlen < 50:
            log("Turnstile token missing/short before Renew click", "WARN")
    elif page_has_math_captcha(page):
        math_mode = True
        try:
            cap_val = page.run_js(
                "const el=document.getElementById('captcha')"
                "||document.querySelector(\"input[name='captcha']\");"
                "return el?String(el.value||'').trim():'';"
            ) or ""
        except Exception:
            cap_val = ""
        log(f"Renew click precheck math captcha filled={bool(cap_val)} value={cap_val!r}")

    selectors = (
        "css:#form-submit button[name='submit_button']",
        "css:button[name='submit_button']",
        "css:form#form-submit button.btn-primary",
        "tag:button:contains(Renew VPS)",
        "tag:button:contains(Renew)",
    )
    btn = None
    for sel in selectors:
        try:
            el = page.ele(sel, timeout=1.5)
        except Exception:
            el = None
        if not el:
            continue
        label = (el.text or "").strip().lower()
        name = (el.attr("name") or "").lower()
        if "cancel" in label:
            continue
        if name == "submit_button" or "renew" in label:
            btn = el
            log(f"Resolved Renew button via {sel!r}: text={(el.text or '').strip()!r}")
            break

    if not btn:
        log("Renew VPS button not found", "ERROR")
        return False

    # Scroll + clear overlays that intercept clicks
    try:
        page.run_js(
            """
            const b = document.querySelector("button[name='submit_button']");
            if (b && b.scrollIntoView) b.scrollIntoView({block:'center', inline:'center'});
            // hide common ad iframes that sit on top of the button
            document.querySelectorAll('iframe[id^="aswift"], ins.adsbygoogle, .adsbygoogle')
              .forEach(el => { try { el.style.pointerEvents='none'; el.style.display='none'; } catch(e){} });
            """
        )
    except Exception:
        try:
            btn.scroll.to_see()
        except Exception:
            pass
    # Math path: give layout/ads a moment before the only click
    time.sleep(1.0 if math_mode else 0.4)
    hide_ads(page)
    if math_mode:
        time.sleep(0.6)

    strategies = []

    def _js_click_once():
        return page.run_js(
            """
            const b = document.querySelector("button[name='submit_button']")
                   || Array.from(document.querySelectorAll('#form-submit button, button.btn-primary'))
                        .find(x => /renew/i.test((x.textContent||'').trim()));
            if (!b) return 'no-btn';
            b.disabled = false;
            b.removeAttribute('disabled');
            b.focus();
            b.click();
            return 'js-click';
            """
        )

    # ---- Math captcha: single slow click, no multi-strategy spam ----
    if math_mode:
        clicked = False
        try:
            # 增加极限拟真：模拟人类查阅和犹豫
            try:
                page.scroll.down(random.randint(100, 300))
                time.sleep(random.uniform(0.5, 1.2))
                btn.scroll.to_see()
                time.sleep(random.uniform(0.3, 0.8))
                btn.hover()
                # Pacing: 故意拖慢答题节奏
                time.sleep(random.uniform(2.5, 4.5))
            except Exception:
                pass
                
            # 强制优先使用原生物理点击绕过 reCAPTCHA 的探针
            btn.click()
            strategies.append("native-click")
            log("Renew click strategy (math, single): native-click")
            clicked = True
        except Exception as e:
            strategies.append(f"native-err:{e}")
            log(f"Native Renew click failed (math): {e}", "WARN")
            
        if not clicked:
            try:
                ret = _js_click_once()
                strategies.append(str(ret))
                log(f"Renew click strategy (math fallback): {ret}")
                clicked = ret not in (None, "no-btn", "")
            except Exception as e2:
                strategies.append(f"js-click-err:{e2}")
                log(f"JS Renew click failed (math fallback): {e2}", "WARN")
                
        if not clicked:
            try:
                btn.click(by_js=True)
                strategies.append("by_js=True")
                log("Renew click strategy (math fallback 2): by_js=True")
                clicked = True
            except Exception as e3:
                strategies.append(f"by_js-err:{e3}")
                log(f"Final Renew click fallback failed (math): {e3}", "WARN")
        # Wait after the single click so AJAX can land; do NOT fire more clicks
        post_wait = float(os.environ.get("WOIDEN_RENEW_POSTCLICK_SEC", "2.5") or "2.5")
        post_wait = max(1.0, min(post_wait, 8.0))
        log(f"Post-Renew single-click wait {post_wait:.1f}s (math mode, no re-click)")
        time.sleep(post_wait)
        if page_has_input_renew_code(page):
            log(f"Renew click strategies tried: {strategies} (got INPUT RENEW CODE)")
        else:
            log(f"Renew click strategies tried: {strategies} (math single-click done)")
        return True

    # ---- Turnstile / other: original multi-strategy (still paced) ----
    # 1) Real DOM click (fires jQuery/vanilla listeners on type=button)
    try:
        ret = _js_click_once()
        strategies.append(str(ret))
        log(f"Renew click strategy: {ret}")
    except Exception as e:
        strategies.append(f"js-click-err:{e}")
        log(f"JS element.click failed: {e}", "WARN")

    time.sleep(1.8)
    if page_has_input_renew_code(page):
        log(f"Renew click strategies tried: {strategies} (got INPUT RENEW CODE)")
        return True

    # 2) DrissionPage native click (coordinates / CDP)
    try:
        btn.click()
        strategies.append("native-click")
        log("Renew click strategy: native-click")
    except Exception as e:
        try:
            btn.click(by_js=True)
            strategies.append("by_js=True")
            log("Renew click strategy: by_js=True")
        except Exception as e2:
            strategies.append(f"native-err:{e2}")
            log(f"Native Renew click failed: {e} / {e2}", "WARN")

    time.sleep(1.8)
    if page_has_input_renew_code(page):
        log(f"Renew click strategies tried: {strategies} (got INPUT RENEW CODE)")
        return True

    # 3) data-callback / global onSubmit (Turnstile-style buttons on Woiden)
    try:
        ret = page.run_js(
            """
            const b = document.querySelector("button[name='submit_button']");
            if (!b) return 'no-btn';
            const cbName = b.getAttribute('data-callback') || b.getAttribute('data-callback-name') || '';
            const tokenEl = document.querySelector(
              'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
            );
            const token = tokenEl ? (tokenEl.value || '') : '';
            // Prefer site callback with token
            if (cbName && typeof window[cbName] === 'function') {
              try { window[cbName](token); return 'data-callback:' + cbName; } catch (e) {
                return 'callback-err:' + String(e).slice(0, 80);
              }
            }
            if (typeof window.onSubmit === 'function') {
              try { window.onSubmit(token); return 'window.onSubmit'; } catch (e2) {
                return 'onSubmit-err:' + String(e2).slice(0, 80);
              }
            }
            // Full mouse sequence ONLY — never form.submit()
            ['pointerdown','mousedown','mouseup','click'].forEach(t => {
              b.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, view:window}));
            });
            return 'mouse-events';
            """
        )
        strategies.append(str(ret))
        log(f"Renew click strategy: {ret}")
    except Exception as e:
        strategies.append(f"callback-err:{e}")
        log(f"callback/mouse fallback failed: {e}", "WARN")

    # Explicitly DO NOT form.submit() / requestSubmit — breaks Woiden AJAX
    log(f"Renew click strategies tried: {strategies}")
    return True


def post_renew_ui_state(page):
    """Snapshot after first Renew click — diagnose empty #response."""
    try:
        return page.run_js(
            """
            const resp = document.getElementById('response');
            const form = document.getElementById('form-submit');
            const link = document.querySelector("a[href*='vps-renew-code']");
            const bodyText = (document.body && document.body.innerText || '').slice(0, 400);
            return {
              url: location.href,
              responseHtml: resp ? (resp.innerHTML || '').slice(0, 300) : null,
              responseText: resp ? (resp.innerText || '').trim().slice(0, 200) : null,
              formDisplay: form ? getComputedStyle(form).display : null,
              hasInputRenewCode: !!link,
              bodySample: bodyText.replace(/\\s+/g, ' ').trim(),
            };
            """
        )
    except Exception as e:
        return {"error": str(e)}


def renew_result_from_page(page):
    """Inspect #response / body for success or error after submit."""
    try:
        resp = page.ele("#response", timeout=2)
        resp_text = (resp.text or "").strip() if resp else ""
    except Exception:
        resp_text = ""
    try:
        body = (page.ele("body", timeout=1).text or "").strip()
    except Exception:
        body = ""
    blob = f"{resp_text}\n{body}".lower()
    log(f"Renew response preview: {(resp_text or body)[:240]!r}")

    # Final success first (must win over intermediate "paste verification code" copy)
    # Real success banner:
    #   "Your VPS has been renewed until July 27, 2026"
    success_markers = (
        "has been renewed until",
        "has been renewed",
        "vps has been renewed",
        "renewed until",
        "successfully renewed",
        "renew success",
        "berhasil",
        "sukses",
        "续期成功",
        "已续期",
    )
    for m in success_markers:
        if m in blob:
            msg = (resp_text or body or m).strip()
            # Prefer the green alert line if present
            for line in (resp_text or body or "").splitlines():
                low = line.strip().lower()
                if "renewed until" in low or "has been renewed" in low or "续期成功" in line:
                    msg = line.strip()
                    break
            log(f"Renew SUCCESS marker matched: {m!r} → {msg!r}")
            return True, msg

    # Intermediate step after first Renew click — not final success
    # (page still says "paste verification code..." as static instruction)
    if page_has_input_renew_code(page) or (
        "verification code has been sent" in blob and "renewed until" not in blob
    ) or ("input renew code" in blob and "renewed until" not in blob):
        return "need_code", resp_text or "verification code sent to telegram"

    # Soft/retryable validation errors (Turnstile/form) — not hard final fail
    if "validation failed" in blob:
        return "retry", resp_text or "Validation failed!"

    # Math captcha wrong on /vps-renew — must re-solve image digits + resubmit.
    # Without this we sit in the post-renew wait loop printing the same line for ~35s.
    captcha_retry_markers = (
        "please solve captcha correctly",
        "solve captcha correctly",
        "captcha correctly",
        "incorrect captcha",
        "wrong captcha",
        "invalid captcha",
        "captcha is incorrect",
        "captcha is wrong",
        "captcha failed",
        "验证码错误",
        "验证码不正确",
    )
    if any(m in blob for m in captcha_retry_markers):
        return "retry", resp_text or body[:200] or "Please solve Captcha correctly!"

    # Broader success keywords (after intermediate check)
    if "successfully" in blob or re.search(r"\brenewed\b", blob):
        if "please paste" not in blob and "verification code that was sent" not in blob:
            return True, resp_text or body[:200] or "renewed"

    # TG verification token rejected — must escalate for a NEW bot code (not L1 reuse).
    # Match before bare "error" so we don't sit 30s re-logging the same line.
    code_reject_markers = (
        "verification code is wrong",
        "your verification code is wrong",
        "verification code wrong",
        "incorrect verification code",
        "wrong verification code",
        "invalid verification code",
        "verification code is invalid",
        "verification code expired",
        "code is wrong",
        "code is invalid",
        "incorrect code",
        "wrong code",
        "invalid code",
        "expired code",
        "验证码错误",
        "验证码不正确",
        "验证码已过期",
    )
    if any(m in blob for m in code_reject_markers):
        msg = (resp_text or body[:200] or "verification code is wrong").strip()
        log(f"TG verification code REJECTED by site: {msg!r}", "WARN")
        return False, msg

    fail_markers = (
        "error", "invalid", "expired", "not eligible",
        "too early", "already", "turnstile", "必填", "失败",
    )
    # bare "fail" is too broad (matches Validation failed — handled above)
    if "fail" in blob and "validation failed" not in blob and "captcha" not in blob:
        fail_markers = fail_markers + ("fail",)
    if any(m in blob for m in fail_markers):
        return False, resp_text or body[:200] or "error text matched"
    return None, resp_text or body[:200]


def page_has_input_renew_code(page):
    """True when green box + INPUT RENEW CODE appears after first renew submit.

    Only trust #response or already on /vps-renew-code. Global anchors / body
    static copy false-positive while #response is still empty.
    """
    try:
        u = (_page_url(page) or "").lower()
        if "vps-renew-code" in u and "login" not in u:
            return True
    except Exception:
        pass

    try:
        st = page.run_js(
            """
            const resp = document.getElementById('response');
            if (!resp) return {ok:false};
            const txt = (resp.innerText || '').trim().toLowerCase();
            const html = (resp.innerHTML || '').toLowerCase();
            if (!txt && !html) return {ok:false};
            const link = resp.querySelector("a[href*='vps-renew-code']");
            const hit =
              !!link
              || txt.includes('verification code has been sent')
              || txt.includes('input renew code')
              || html.includes('vps-renew-code')
              || html.includes('input renew code');
            return {ok: hit};
            """
        )
        if isinstance(st, dict) and st.get("ok"):
            return True
    except Exception:
        pass

    try:
        resp = page.ele("#response", timeout=0.5)
        if resp:
            txt = (resp.text or "").strip().lower()
            html = ""
            try:
                html = (resp.html or "").lower()
            except Exception:
                html = ""
            if txt or html:
                if (
                    "verification code has been sent" in txt
                    or "input renew code" in txt
                    or "vps-renew-code" in html
                    or "input renew code" in html
                ):
                    return True
                try:
                    if resp.ele("css:a[href*='vps-renew-code']", timeout=0.2):
                        return True
                except Exception:
                    pass
    except Exception:
        pass
    return False


def _code_page_ready(page) -> bool:
    """True when /vps-renew-code form is usable (#code present)."""
    try:
        if page.ele("#code", timeout=0.4) or page.ele("css:input[name='code']", timeout=0.3):
            return True
    except Exception:
        pass
    u = (_page_url(page) or "").lower()
    return "vps-renew-code" in u and "login" not in u


def click_input_renew_code(page, max_attempts: int = 3):
    """Open /vps-renew-code after green INPUT RENEW CODE appears.

    Real failure mode: button is visible but click / location.assign does not
    land on #code. Retry several strategies; return False so caller can re-do
    the first Renew (new TG code) instead of dying on a half-open page.
    """
    hide_ads(page)
    if _code_page_ready(page):
        log(f"already on renew-code page url={_page_url(page)!r}")
        return True

    def _poll_ready(seconds=12, label=""):
        for i in range(max(1, int(seconds))):
            hide_ads(page)
            if _code_page_ready(page):
                log(f"vps-renew-code ready ({label}#{i+1}s) url={_page_url(page)!r}")
                return True
            if i in (4, 8) and label:
                log(f"… waiting vps-renew-code ({label} {i}s) url={_page_url(page)!r}")
            time.sleep(1)
        return False

    strategies = []

    for attempt in range(1, max(1, int(max_attempts)) + 1):
        log(f"Open INPUT RENEW CODE / vps-renew-code attempt {attempt}/{max_attempts}")
        hide_ads(page)

        # A) Click the green button first (keeps site flow / session)
        clicked = False
        for sel in (
            "css:#response a[href*='vps-renew-code']",
            "css:#response a.btn-primary",
            "css:a.btn[href*='vps-renew-code']",
            "tag:a:contains(INPUT RENEW CODE)",
            "tag:a:contains(Input Renew Code)",
            "css:a[href*='vps-renew-code']",
        ):
            try:
                el = page.ele(sel, timeout=1.0)
            except Exception:
                el = None
            if not el:
                continue
            try:
                href = el.attr("href") or ""
            except Exception:
                href = ""
            log(f"Click INPUT RENEW CODE via {sel!r} href={href!r}")
            try:
                page.run_js(
                    "const a=arguments[0]; if(a&&a.scrollIntoView) a.scrollIntoView({block:'center'});",
                    el,
                )
            except Exception:
                pass
            try:
                el.click()
                clicked = True
                strategies.append(f"click:{sel}")
                break
            except Exception:
                try:
                    page.run_js("arguments[0].click();", el)
                    clicked = True
                    strategies.append(f"js-click:{sel}")
                    break
                except Exception as e:
                    log(f"click {sel} failed: {e}", "WARN")
                    continue

        if clicked and _poll_ready(10, label=f"after-click-{attempt}"):
            return True

        # B) JS: find link in #response and navigate
        try:
            ret = page.run_js(
                """
                const a = document.querySelector("#response a[href*='vps-renew-code']")
                       || document.querySelector("a[href*='vps-renew-code']");
                if (a) {
                  const href = a.getAttribute('href') || a.href || '';
                  a.click();
                  return href || 'clicked';
                }
                return '';
                """
            )
            if ret:
                strategies.append(f"response-js:{ret}")
                log(f"JS clicked renew-code link → {ret!r}")
                if _poll_ready(8, label=f"after-js-{attempt}"):
                    return True
        except Exception as e:
            log(f"JS response link click failed: {e}", "WARN")

        # C) location.assign hard path
        try:
            log("Open /vps-renew-code via location.assign")
            page.run_js("location.assign('https://woiden.id/vps-renew-code');")
            strategies.append("location.assign")
            if _poll_ready(12, label=f"assign-{attempt}"):
                return True
        except Exception as e:
            log(f"location.assign failed: {e}", "WARN")

        # D) location.href
        try:
            page.run_js("location.href='https://woiden.id/vps-renew-code';")
            strategies.append("location.href")
            if _poll_ready(10, label=f"href-{attempt}"):
                return True
        except Exception as e:
            log(f"location.href failed: {e}", "WARN")

        # E) last resort page.get (can be slow)
        if attempt >= max_attempts:
            try:
                log("fallback page.get /vps-renew-code")
                try:
                    page.set.timeouts(page_load=15)
                except Exception:
                    pass
                page.get("https://woiden.id/vps-renew-code")
                strategies.append("page.get")
                if _poll_ready(12, label="page.get"):
                    return True
            except Exception as e:
                log(f"page.get renew-code failed: {e}", "ERROR")

        # Still on renew page with button? small pause then retry
        u = _page_url(page)
        log(f"renew-code not ready after attempt {attempt} url={u!r}", "WARN")
        time.sleep(1.0)

    log(f"Failed to open /vps-renew-code strategies={strategies} url={_page_url(page)!r}", "ERROR")
    return False


def _extract_WOIDEN_bot_code(text):
    """Pull renew verification code from HAXTG_BOT message.

    Real messages often wrap the token across lines, e.g.:
      Your Code is
      ODkwNDA3ODk3Nzo6OjYwNzYzZDAxZDY2YzRmNjAyODFkYmQzYzEzNGRmNTU
      y

    So after matching "Your Code is", join subsequent base64-ish lines.
    """
    if not text:
        return None
    raw = str(text).replace("\r\n", "\n").replace("\r", "\n").strip()

    # 1) Preferred: "Your Code is" then token may span multiple lines
    m = re.search(r"(?is)your\s*code\s*is\s*[:\-]?\s*(.+)$", raw)
    if m:
        tail = m.group(1).strip()
        # Keep only base64-ish chars (including ':' used by Woiden payload)
        joined = re.sub(r"[^A-Za-z0-9+/_=\-:]+", "", tail)
        # Trim trailing junk words if any leaked
        if len(joined) >= 16:
            return joined

    # 2) Standalone long token with :: (Woiden style)
    #    Collapse whitespace first so wrapped tokens still match
    compact = re.sub(r"\s+", "", raw)
    m = re.search(r"([A-Za-z0-9+/_=]{8,}::{1,3}[A-Za-z0-9+/_=]{8,})", compact)
    if m:
        return m.group(1).strip()

    # 3) Any long base64-like blob
    m = re.search(r"([A-Za-z0-9+/_=\-:]{24,})", compact)
    if m:
        code = m.group(1).strip()
        if "http" not in code.lower() and "yourcodeis" not in code.lower():
            return code

    return None


def _woiden_bot_chat_candidates():
    """Bot usernames / ids that send the renew verification code.

    Woiden and Hax share the same Telegram bots. Prefer Hax bot names.
    Override with WOIDEN_RENEW_BOT / WOIDEN_TG_BOT / HAX_RENEW_BOT if needed.
    """
    extra = (
        os.environ.get("WOIDEN_RENEW_BOT")
        or os.environ.get("WOIDEN_TG_BOT")
        or os.environ.get("HAX_RENEW_BOT")
        or os.environ.get("HAX_TG_BOT")
        or ""
    ).strip()
    chats = []
    if extra:
        chats.append(extra.lstrip("@"))
    chats.extend(
        [
            # Shared bots with Hax (same free-vps stack)
            "HAXTG_BOT",
            "Haxtg_bot",
            "haxTG_bot",
            "loginhaxbot",
        ]
    )
    # de-dupe preserve order
    out, seen = [], set()
    for c in chats:
        key = str(c).lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


async def snapshot_woiden_bot_msg_ids(client) -> dict:
    """Latest message id per HAXTG_BOT chat — used as since_id before L2 re-Renew."""
    out = {}
    for chat_id in _woiden_bot_chat_candidates():
        try:
            mid = await get_latest_message_id(client, chat_id)
            if mid:
                out[chat_id] = int(mid)
        except Exception as e:
            log(f"Pyrogram: snapshot {chat_id} failed: {e}", "WARN")
    log(f"Pyrogram: bot since snapshot={out}")
    return out


def _since_for_chat(since_ids: dict, chat_id) -> int:
    since_ids = dict(since_ids or {})
    since = int(since_ids.get(chat_id, 0) or 0)
    if since:
        return since
    for k, v in since_ids.items():
        if str(k).lower() == str(chat_id).lower():
            return int(v or 0)
    return 0


async def fetch_WOIDEN_bot_code(
    client, since_ids=None, timeout=90, prefer_latest=True, require_newer=False
):
    """Read renew verification code from HAXTG_BOT.

    Important timing:
      Site sends the bot message when Renew succeeds (INPUT RENEW CODE appears),
      often BEFORE we start listening. So we must NOT snapshot since_id after that
      moment and then only accept newer ids — that drops the already-arrived code.

    Strategy:
      1) Scan recent history (newest first via get_chat_history)
      2) Collect ALL messages that contain a parseable code
      3) Return the newest one (highest msg.id) — user may get 2 codes; use last
      4) If since_ids provided, prefer codes with id > since
      5) require_newer=True (L2 after re-Renew): ONLY accept id > since, no fallback
         to older codes (avoids reusing the previous attempt's token)
    """
    since_ids = dict(since_ids or {})
    chats = _woiden_bot_chat_candidates()

    log(
        f"Pyrogram: reading renew code from {chats} "
        f"timeout={timeout}s since={since_ids} prefer_latest={prefer_latest} "
        f"require_newer={int(bool(require_newer))}"
    )
    start = time.time()

    def _collect_candidates():
        # returns list of (msg_id, chat_id, code, preview)
        found = []
        async def _run():
            for chat_id in chats:
                try:
                    async for msg in client.get_chat_history(chat_id, limit=15):
                        text = msg.text or msg.caption or ""
                        if not text:
                            continue
                        code = _extract_WOIDEN_bot_code(text)
                        preview = text[:160].replace("\n", " ")
                        # Always log candidates so we can see what was visible
                        if code or re.search(r"(?i)your\s*code", text):
                            log(
                                f"Pyrogram: bot msg chat={chat_id} id={msg.id} "
                                f"code={'yes' if code else 'no'} text={preview!r}"
                            )
                        if code:
                            found.append((int(msg.id or 0), chat_id, code, preview))
                except Exception as e:
                    log(f"Pyrogram: poll {chat_id} failed: {e}", "WARN")
            return found

        return _run()

    while time.time() - start < timeout:
        candidates = await _collect_candidates()
        if candidates:
            # Newest first
            candidates.sort(key=lambda x: x[0], reverse=True)
            # Prefer codes newer than since snapshot when available
            newer = []
            for msg_id, chat_id, code, preview in candidates:
                since = _since_for_chat(since_ids, chat_id)
                if not since or msg_id > since:
                    newer.append((msg_id, chat_id, code, preview))

            if require_newer:
                if not newer:
                    # Wait for a brand-new bot message after L2 re-Renew
                    await asyncio.sleep(2)
                    continue
                pick = newer[0]
            else:
                pick = (newer or candidates)[0]
            msg_id, chat_id, code, preview = pick
            log(
                f"Pyrogram: using LATEST renew code from {chat_id} msg={msg_id} "
                f"len={len(code)} preview={code[:24]!r}... "
                f"(candidates={len(candidates)} newer_than_since={len(newer)} "
                f"require_newer={int(bool(require_newer))})"
            )
            return code, msg_id, chat_id

        await asyncio.sleep(2)

    log("Pyrogram: no parseable 'Your Code is' message in recent bot history", "ERROR")
    return None, None, None


def _reload_renew_code_page(page) -> bool:
    """L1: hard-refresh /vps-renew-code (math+reCAPTCHA reset; code token reused)."""
    log_phase("L1", "reload /vps-renew-code (reuse TG code, redo math+reCAPTCHA)")
    try:
        page.run_js("location.assign('https://woiden.id/vps-renew-code');")
    except Exception:
        try:
            page.get("https://woiden.id/vps-renew-code")
        except Exception as e:
            log(f"L1 reload renew-code failed: {e}", "ERROR")
            return False
    time.sleep(2.0)
    hide_ads(page)
    # wait for form
    for i in range(12):
        if _code_page_ready(page):
            log_phase("L1", f"renew-code ready after reload ({i+1}s)")
            return True
        if is_on_login_page(page):
            log_phase("L1", f"dropped to /login during reload", "WARN")
            return False
        time.sleep(1)
    log_phase("L1", f"renew-code not ready after reload url={_page_url(page)!r}", "WARN")
    return _code_page_ready(page)


def _code_reject_reason(reason: str) -> bool:
    """True when server rejected the TG verification token (need L2 new code).

    Real Woiden banner: "Error! Your verification code is wrong"
    L1 must NOT reuse that token — only a fresh first-Renew → new HAXTG_BOT code.
    """
    r = (reason or "").lower()
    if not r:
        return False
    exactish = (
        "verification code is wrong",
        "your verification code is wrong",
        "verification code wrong",
        "incorrect verification code",
        "wrong verification code",
        "invalid verification code",
        "verification code is invalid",
        "verification code expired",
        "code is wrong",
        "code is invalid",
        "incorrect code",
        "wrong code",
        "invalid code",
        "expired code",
        "code expired",
        "code rejected",
        "验证码错误",
        "验证码不正确",
        "验证码已过期",
    )
    if any(k in r for k in exactish):
        return True
    # "verification code" + bad word
    if "verification code" in r and any(
        w in r for w in ("invalid", "incorrect", "wrong", "expired", "fail", "error")
    ):
        return True
    return False


def _set_input_value(page, el, value):
    try:
        el.input(str(value), clear=True)
        return True
    except Exception:
        pass
    try:
        page.run_js(
            "const el=arguments[0]; const v=String(arguments[1]??'');"
            "el.focus(); el.value=v;"
            "el.dispatchEvent(new Event('input',{bubbles:true}));"
            "el.dispatchEvent(new Event('change',{bubbles:true}));"
            "return el.value;",
            el,
            str(value),
        )
        return True
    except Exception as e:
        log(f"_set_input_value failed: {e}", "WARN")
        return False


def _eval_math_expr(a, op, b):
    a, b = int(a), int(b)
    op = str(op).strip()
    if op in {"+", "＋"}:
        return a + b
    if op in {"-", "－", "−"}:
        return a - b
    if op in {"*", "x", "×", "X", "⋅"}:
        return a * b
    if op in {"/", "÷", ":"} and b:
        return a // b
    return None


def solve_math_captcha_on_page(page, shots_dir=None):
    """Solve arithmetic captcha into #captcha (Woiden /vps-renew and renew-code).

    Real DOM (current Woiden renew):
      .form-group.row
        .col-sm-3
          <img src="https://woiden.id/img/temp/....jpg">  # digit A (image)
          "x" / "+" / ...
          <img src="https://woiden.id/img/temp/....jpg">  # digit B (image)
        .col-sm-2
          input#captcha[name=captcha]

    Digits are images → prefer Vision. Plain-text parse is only a fallback.
    """
    expr = None
    answer = None
    debug = {}
    shots_dir = shots_dir or os.environ.get("BROWSER_SCREENSHOTS_DIR") or tempfile.gettempdir()

    # Prefer Vision when digit images are present (Woiden main renew form)
    try:
        img_count = int(
            page.run_js(
                """
                const cap = document.getElementById('captcha')
                         || document.querySelector("input[name='captcha']");
                if (!cap) return 0;
                const row = cap.closest('.form-group.row') || cap.closest('.form-group') || cap.parentElement;
                if (!row) return 0;
                return row.querySelectorAll('img[src*="img/temp"], img[src*="/temp/"]').length || 0;
                """
            )
            or 0
        )
    except Exception:
        img_count = 0
    if img_count >= 1:
        log(f"Math captcha: {img_count} digit image(s) — using Vision first")
        try:
            from woiden_yolo.math_vision import solve_math_captcha_with_vision

            if solve_math_captcha_with_vision(page, shots_dir=shots_dir):
                return True
            log("Vision math path returned false — fall back to text scrape", "WARN")
        except Exception as e:
            log(f"Vision math path failed: {e}", "WARN")

    # Richer DOM scrape: textContent of captcha row + nearby columns + full form
    try:
        found = page.run_js(
            r"""
            const cap = document.getElementById('captcha')
                     || document.querySelector("input[name='captcha']");
            const out = {capFound: !!cap, samples: []};
            function pushSample(tag, el) {
              if (!el) return;
              const t = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();
              if (t) out.samples.push({tag, t: t.slice(0, 120)});
            }
            if (cap) {
              const row = cap.closest('.form-group.row') || cap.closest('.form-group') || cap.closest('.row') || cap.parentElement;
              pushSample('row', row);
              if (row) {
                row.querySelectorAll('div,span,label,b,strong,font,p').forEach((el, i) => {
                  if (el.contains(cap)) return;
                  const t = ((el.innerText || el.textContent || '') + '').trim();
                  if (t && t.length < 40) pushSample('row-child-'+i, el);
                });
              }
              // previous sibling column
              let col = cap.closest('.col-sm-2, .col-sm-3, .col-md-2, .col-md-3');
              if (col && col.previousElementSibling) pushSample('prev-col', col.previousElementSibling);
            }
            const form = document.getElementById('form-submit');
            pushSample('form', form);
            // scan all short nodes under form for math-like text
            const root = form || document.body;
            const hits = [];
            root.querySelectorAll('div,span,label,b,strong,font,td,p').forEach(el => {
              const t = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();
              if (!t || t.length > 20) return;
              if (/\d\s*[+\-−×x*\/÷]\s*\d/.test(t)) hits.push(t);
            });
            out.hits = hits.slice(0, 10);
            // also raw HTML snippet near captcha for debugging
            if (cap && cap.parentElement && cap.parentElement.parentElement) {
              out.html = (cap.parentElement.parentElement.innerHTML || '').slice(0, 300);
            }
            const blob = [out.hits.join(' | '), ...(out.samples.map(s => s.t))].join(' || ');
            const m = blob.match(/(\d{1,3})\s*([+\-−×x*\/÷])\s*(\d{1,3})/);
            out.match = m ? {a: m[1], op: m[2], b: m[3], raw: m[0]} : null;
            out.blob = blob.slice(0, 200);
            return out;
            """
        )
        debug = found if isinstance(found, dict) else {"raw": found}
        log(f"Math captcha scrape: hits={debug.get('hits')!r} blob={debug.get('blob')!r} match={debug.get('match')!r}")
        if isinstance(found, dict) and found.get("match"):
            m = found["match"]
            answer = _eval_math_expr(m.get("a"), m.get("op"), m.get("b"))
            expr = m.get("raw")
    except Exception as e:
        log(f"math captcha JS parse failed: {e}", "WARN")

    # Fallback: walk elements with DrissionPage
    if answer is None:
        selectors = (
            "css:.form-group.row .col-sm-3",
            "css:.form-group.row .col-sm-4",
            "css:form#form-submit .col-sm-3",
            "css:.form-group.row",
            "css:form#form-submit",
            "css:#form-submit .form-group",
        )
        for sel in selectors:
            try:
                els = page.eles(sel) if hasattr(page, "eles") else [page.ele(sel, timeout=0.8)]
            except Exception:
                els = []
            for el in els or []:
                if not el:
                    continue
                try:
                    text = (el.text or "") + " " + (el.attr("innerText") or "")
                except Exception:
                    try:
                        text = el.text or ""
                    except Exception:
                        text = ""
                m = re.search(r"(\d{1,3})\s*([+\-−×x*/÷])\s*(\d{1,3})", text)
                if m:
                    answer = _eval_math_expr(m.group(1), m.group(2), m.group(3))
                    expr = m.group(0)
                    log(f"Math via {sel!r}: {expr!r}")
                    break
            if answer is not None:
                break

    if answer is None:
        try:
            body = page.ele("body", timeout=1).text or ""
            m = re.search(r"(\d{1,3})\s*([+\-−×x*/÷])\s*(\d{1,3})", body)
            if m:
                answer = _eval_math_expr(m.group(1), m.group(2), m.group(3))
                expr = m.group(0)
        except Exception:
            pass

    # Answer box always #captcha — fill even if we only guess later
    math_input = (
        page.ele("#captcha", timeout=3)
        or page.ele("css:input[name='captcha']", timeout=1)
        or page.ele("css:input#captcha.form-control", timeout=1)
    )

    if answer is None:
        # Digits are dynamic <img> URLs — use Vision on row screenshot
        log("No plain-text math expression — try Vision on digit images")
        try:
            from woiden_yolo.math_vision import solve_math_captcha_with_vision

            if solve_math_captcha_with_vision(page, shots_dir=shots_dir):
                return True
        except Exception as e:
            log(f"math vision path failed: {e}", "ERROR")
        try:
            html = page.run_js(
                """
                const cap = document.getElementById('captcha');
                if (!cap) return 'no #captcha';
                const row = cap.closest('.form-group') || cap.parentElement;
                return row ? row.outerHTML.slice(0, 500) : 'no row';
                """
            )
            log(f"Math captcha row HTML: {html!r}", "WARN")
        except Exception:
            pass
        log("No math captcha expression found on renew-code page", "WARN")
        return False

    log(f"Math captcha: {expr!r} => {answer}")
    if not math_input:
        log("Math captcha #captcha input not found", "ERROR")
        return False

    if not _set_input_value(page, math_input, str(int(answer))):
        return False
    try:
        got = (math_input.value or math_input.attr("value") or "").strip()
    except Exception:
        got = ""
    log(f"Filled #captcha math answer: expect={answer} dom={got!r}")
    if re.sub(r"\D", "", got) != str(int(answer)):
        try:
            page.run_js(
                "const el=document.getElementById('captcha');"
                "if(!el) return null;"
                "el.value=String(arguments[0]).replace(/\\D+/g,'');"
                "el.dispatchEvent(new Event('input',{bubbles:true}));"
                "el.dispatchEvent(new Event('keyup',{bubbles:true}));"
                "el.dispatchEvent(new Event('change',{bubbles:true}));"
                "return el.value;",
                int(answer),
            )
        except Exception as e:
            log(f"force #captcha failed: {e}", "WARN")
    return True


def solve_recaptcha_with_yolo(page, shots_dir, max_rounds=None):
    """reCAPTCHA on /vps-renew-code: **audio first**, YOLO image fallback.

    No WARP / IP rotation. Stay on current page only.

    Order:
      fill #code → math #captcha → HERE → final Renew VPS
    """
    hide_ads(page)
    # Prefer panel run dir (shots_dir / TASK_SCREENSHOT_DIR); never silently fall back
    # to bare /tmp or gallery will show zero images after a successful renew.
    base = (
        (shots_dir or "").strip()
        or (os.environ.get("TASK_SCREENSHOT_DIR") or "").strip()
        or (os.environ.get("BROWSER_SCREENSHOTS_DIR") or "").strip()
        or (os.environ.get("SCREENSHOT_DIR") or "").strip()
        or (os.environ.get("ARTIFACTS_DIR") or "").strip()
        or tempfile.gettempdir()
    )
    recaptcha_shots = os.path.join(base, "yolo-recaptcha-code")
    os.makedirs(recaptcha_shots, exist_ok=True)
    log(f"reCAPTCHA / yolo_hard shots → {recaptcha_shots}")

    try:
        has_rc = bool(
            page.ele("css:iframe[src*='recaptcha']", timeout=2)
            or page.ele("css:.g-recaptcha, .rc-anchor, iframe[title*='reCAPTCHA']", timeout=1)
        )
    except Exception:
        has_rc = False

    if not has_rc:
        try:
            has_rc = bool(
                page.run_js(
                    "return !!(document.querySelector(\"iframe[src*='recaptcha']\")"
                    "|| document.querySelector('.g-recaptcha')"
                    "|| document.querySelector(\"iframe[title*='reCAPTCHA']\"));"
                )
            )
        except Exception:
            has_rc = False

    if not has_rc:
        log("No Google reCAPTCHA widget on renew-code page")
        return True

    if is_recaptcha_solved(page):
        log("reCAPTCHA already solved")
        return True

    # 轮次：唯一解析点 resolve_yolo_max_rounds()。环境变量说几轮就是几轮 ——
    # 不再 max(..., 12) 抬硬下限（配 6 被抬成 12 就是这里干的），
    # 也不再写回 os.environ（改写会污染同进程后续任务）。
    # max_rounds 形参只作为环境变量未设置时的兜底默认值。
    yolo_rounds = resolve_yolo_max_rounds(int(max_rounds or 0))

    # Preferred: audio module (no WARP). Falls back to YOLO inside helper.
    if solve_recaptcha_audio_then_yolo is not None:
        log(
            f"Google reCAPTCHA → audio first, YOLO fallback "
            f"(yolo_max_rounds={yolo_rounds}, no WARP/IP rotate)"
        )
        try:
            ok = solve_recaptcha_audio_then_yolo(
                page, screenshot_dir=recaptcha_shots, max_rounds=yolo_rounds
            )
        except Exception as e:
            log(f"audio+yolo path error: {e}", "ERROR")
            ok = False
        solved = bool(ok or is_recaptcha_solved(page))
        log(f"reCAPTCHA audio/yolo result={ok} solved={solved}")
        if solved:
            log("Google reCAPTCHA solved")
            return True
        log("Google reCAPTCHA NOT solved (audio+yolo)", "ERROR")
        return False

    # Fallback if audio module missing: YOLO only
    if handle_recaptcha_yolo is None:
        log("neither audio nor YOLO recaptcha module available", "ERROR")
        return False

    log(f"audio module missing → YOLO only (max_rounds={yolo_rounds})")
    try:
        from woiden_yolo.dom import challenge_ui_ready, force_reopen_recaptcha

        if not challenge_ui_ready(page, timeout=1.0):
            log("YOLO-only pre-open: force_reopen_recaptcha")
            force_reopen_recaptcha(page, max_clicks=3)
            time.sleep(1.2)
    except Exception as e:
        log(f"YOLO-only pre-open failed: {e}", "WARN")
    try:
        ok = handle_recaptcha_yolo(
            page, screenshot_dir=recaptcha_shots, max_rounds=yolo_rounds
        )
    except Exception as e:
        log(f"YOLO handle failed: {e}", "ERROR")
        ok = False
    solved = bool(ok or is_recaptcha_solved(page))
    if solved:
        log("Google reCAPTCHA solved via YOLO")
        return True
    log("Google reCAPTCHA NOT solved after YOLO", "ERROR")
    return False


def click_final_renew_vps(page):
    """Click the final Renew VPS on /vps-renew-code after captchas are done.

    Real DOM:
      <button name="submit_button" type="button" class="btn btn-primary"
              data-sitekey="..." data-callback="onSubmit">Renew VPS</button>
    Note: type=button (not submit); often bound to reCAPTCHA data-callback.
    """
    hide_ads(page)
    selectors = (
        "css:#form-submit button[name='submit_button']",
        "css:button[name='submit_button']",
        "css:form#form-submit button.btn-primary",
        "css:button.btn.btn-primary[data-callback]",
        "tag:button:contains(Renew VPS)",
        "tag:button:contains(Renew)",
        "css:button.btn-primary",
    )
    btn = None
    for sel in selectors:
        try:
            el = page.ele(sel, timeout=1.5)
        except Exception:
            el = None
        if not el:
            continue
        label = (el.text or "").strip().lower()
        name = (el.attr("name") or "").lower()
        if "cancel" in label:
            continue
        if name == "submit_button" or "renew" in label or "btn-primary" in sel:
            btn = el
            log(f"Final Renew VPS via {sel!r}: text={(el.text or '').strip()!r}")
            break

    if not btn:
        log("Final Renew VPS button not found", "ERROR")
        return False

    # Prefer real click; fallback JS / grecaptcha callback
    try:
        btn.click()
        log("Clicked final Renew VPS")
        time.sleep(2)
        return True
    except Exception as e:
        log(f"Final Renew click failed: {e}, try JS", "WARN")

    try:
        page.run_js(
            """
            const b = document.querySelector("button[name='submit_button']")
                   || Array.from(document.querySelectorAll('button'))
                        .find(x => /renew\\s*vps/i.test(x.textContent||''));
            if (b) {
              b.click();
              // If this is a reCAPTCHA v2 invisible/callback button, also try execute
              try {
                if (window.grecaptcha && b.getAttribute('data-sitekey')) {
                  // normal v2 checkbox flow already solved; just click is enough
                }
              } catch (e) {}
              return true;
            }
            const f = document.getElementById('form-submit');
            if (f) {
              if (f.requestSubmit) f.requestSubmit();
              else f.submit();
              return 'submit';
            }
            return false;
            """
        )
        log("Clicked final Renew VPS via JS")
        time.sleep(2)
        return True
    except Exception as e:
        log(f"JS final Renew failed: {e}", "ERROR")
        return False


def fill_renew_code_page(page, code, shots_dir=None, max_rounds=None):
    """Complete /vps-renew-code page once (no outer retry).

      1) paste verification token into #code  (from @HAXTG_BOT)
      2) solve math captcha into #captcha
      3) Google reCAPTCHA via YOLO
      4) click final Renew VPS button

    Returns:
      True  — form submitted (caller waits for success banner)
      False — hard fail on this attempt (missing fields / yolo / click)
      "off_page" — no longer on renew-code (login bounce etc.)
    """
    hide_ads(page)
    if is_on_login_page(page):
        log(f"fill_renew_code_page: on /login url={_page_url(page)!r}", "WARN")
        return "off_page"
    if not _code_page_ready(page):
        log(f"fill_renew_code_page: not on code page url={_page_url(page)!r}", "WARN")
        return "off_page"

    # --- 1) #code ---
    code_input = (
        page.ele("#code", timeout=8)
        or page.ele("css:input[name='code']", timeout=2)
        or page.ele("css:input#code.form-control", timeout=1)
    )
    if not code_input:
        log("No #code input on vps-renew-code page", "ERROR")
        return False

    if not _set_input_value(page, code_input, code):
        log("Failed to set #code", "ERROR")
        return False
    try:
        val = (code_input.value or code_input.attr("value") or "")[:48]
    except Exception:
        val = "?"
    log(f"[1/4] Filled #code ({len(str(code))} chars) preview={val!r}...")

    # --- 2) math #captcha ---
    log("[2/4] Solving math captcha into #captcha...")
    if not solve_math_captcha_on_page(page):
        log("Math captcha failed — continue anyway (page may not require it)", "WARN")

    # --- 3) Google reCAPTCHA / YOLO ---
    log("[3/4] Google reCAPTCHA → YOLO...")
    if not solve_recaptcha_with_yolo(page, shots_dir=shots_dir, max_rounds=max_rounds):
        log("YOLO reCAPTCHA failed on renew-code page", "ERROR")
        # may have bounced off page during long solve
        if is_on_login_page(page) or not _code_page_ready(page):
            return "off_page"
        return False

    # --- 4) final Renew VPS ---
    log("[4/4] Clicking final Renew VPS...")
    if not click_final_renew_vps(page):
        log("Final Renew VPS click failed", "ERROR")
        if is_on_login_page(page) or not _code_page_ready(page):
            return "off_page"
        return False

    return True


def _wait_final_renew_result(page, shots_dir, wait_sec=30):
    """After code-page submit: poll success/fail banner.

    On "verification code is wrong" return immediately as retry (need NEW TG code).
    Do not sit 30s reprinting the same error — that burns L1 reusing a dead token.
    """
    log("Waiting for final success banner (renewed until ...)...")
    time.sleep(1.2)
    last_reason = ""
    for i in range(max(5, int(wait_sec))):
        hide_ads(page)
        if is_on_login_page(page):
            return (
                "retry",
                f"session dropped to /login after code submit url={_page_url(page)!r}",
                take_screenshot(page, shots_dir, "code-post-login"),
            )
        ok, reason = renew_result_from_page(page)
        last_reason = reason or last_reason
        if ok is True:
            log(f"FINAL SUCCESS: {reason}")
            shot = take_screenshot(page, shots_dir, "renew-success")
            return True, reason, shot
        if ok is False:
            log(f"FINAL FAIL: {reason}", "ERROR")
            shot = take_screenshot(page, shots_dir, "renew-fail")
            # code rejected → L2 new code; NEVER L1-reuse this token
            if _code_reject_reason(reason or ""):
                return "retry", f"code rejected: {reason}", shot
            return False, reason, shot
        # Soft path: some builds only put text in #response without hard fail flag
        if _code_reject_reason(str(reason or "")):
            log(f"FINAL FAIL (code reject soft): {reason}", "ERROR")
            shot = take_screenshot(page, shots_dir, "renew-code-rejected")
            return "retry", f"code rejected: {reason}", shot
        if i % 5 == 0:
            log(f"… still waiting final result ({i}s): {str(reason)[:120]!r}")
        time.sleep(1)
    shot = take_screenshot(page, shots_dir, "renew-code-unknown")
    # If the last line was already a code-wrong banner, treat as reject not "unclear"
    if _code_reject_reason(str(last_reason or "")):
        return "retry", f"code rejected: {last_reason}", shot
    return None, f"code submitted, no success banner yet: {last_reason}", shot


def handle_post_renew_code_flow(page, client, shots_dir, since_ids=None, require_newer=False):
    """After first Renew VPS: green alert → INPUT RENEW CODE → HAXTG_BOT code → submit.

    Real UI chain:
      1) #response .alert-success + a[href=/vps-renew-code] INPUT RENEW CODE
      2) /vps-renew-code :
           input#code  (long token from @HAXTG_BOT "Your Code is ...")
           math captcha e.g. 5 + 1
           reCAPTCHA

    Retry layers (inside this function):
      L1 — still on code page: reload /vps-renew-code, REUSE same TG code,
           redo math + reCAPTCHA (default WOIDEN_CODE_PAGE_L1_RETRIES=2)
      off-page / code rejected / L1 exhausted → return "retry" for outer L2
           (re-Renew → new bot code; L2 cap is WOIDEN_CODE_L2_RETRIES default 5)

    since_ids / require_newer: L2 path must only accept bot msgs newer than snapshot.
    """
    l1_retries = max(0, int(os.environ.get("WOIDEN_CODE_PAGE_L1_RETRIES", "2")))
    yolo_rounds = resolve_yolo_max_rounds()

    # Wait for the intermediate UI (may take a few seconds after submit)
    end = time.time() + 45
    appeared = False
    while time.time() < end:
        hide_ads(page)
        if is_on_login_page(page):
            shot = take_screenshot(page, shots_dir, "code-flow-login")
            return "retry", "session dropped to /login before code step", shot
        if page_has_input_renew_code(page):
            appeared = True
            break
        # already navigated to code page (e.g. after L2 re-open)
        if _code_page_ready(page):
            appeared = True
            break
        ok, reason = renew_result_from_page(page)
        if ok is True:
            return True, reason, take_screenshot(page, shots_dir, "renew-success-early")
        if ok is False:
            return False, reason, take_screenshot(page, shots_dir, "renew-fail-early")
        time.sleep(1)

    if not appeared:
        log("INPUT RENEW CODE UI did not appear", "WARN")
        return None, "no input-renew-code UI", None

    log("Detected INPUT RENEW CODE step — code was sent to Telegram (@HAXTG_BOT)")
    loop = _event_loop()

    # 1) Read bot code FIRST (usually already in chat when button appears).
    log(
        "Pyrogram: reading HAXTG_BOT code first "
        f"(before slow page nav, require_newer={int(bool(require_newer))})"
    )
    code_timeout = int(os.environ.get("WOIDEN_BOT_CODE_TIMEOUT", "45"))
    code, mid, from_chat = loop.run_until_complete(
        fetch_WOIDEN_bot_code(
            client,
            since_ids=since_ids or {},
            timeout=code_timeout,
            prefer_latest=True,
            require_newer=bool(require_newer),
        )
    )
    if not code:
        shot = take_screenshot(page, shots_dir, "bot-code-missing")
        # L2 may need another re-Renew if brand-new code never arrived
        if require_newer:
            return "retry", "HAXTG_BOT new renew code not received after re-Renew", shot
        return False, "HAXTG_BOT renew code not received (Your Code is ...)", shot
    log(f"Using renew code from {from_chat} msg={mid}: len={len(code)}")

    # 2) Open code page — open fail → outer L2 re-Renew
    if not _code_page_ready(page):
        if not click_input_renew_code(page, max_attempts=3):
            shot = take_screenshot(page, shots_dir, "input-renew-code-click-fail")
            log(
                "Failed to open /vps-renew-code after INPUT RENEW CODE — "
                "caller should re-run first Renew (L2)",
                "ERROR",
            )
            return "retry", "Failed to open /vps-renew-code (click INPUT RENEW CODE)", shot

    hide_ads(page)
    if not (page.ele("#code", timeout=3) or page.ele("css:input[name='code']", timeout=1)):
        shot = take_screenshot(page, shots_dir, "code-input-missing")
        return (
            "retry",
            f"renew-code page missing #code (url={_page_url(page)!r})",
            shot,
        )

    # 3) L1 loop: same TG code ONLY for math/yolo failures.
    # If site says verification code is wrong → stop L1 immediately, L2 new code.
    last_shot = None
    last_reason = "Failed on renew-code page (code/math/yolo/submit)"
    for l1 in range(0, l1_retries + 1):
        if l1 > 0:
            log_phase("L1", f"retry {l1}/{l1_retries} reload + reuse TG code msg={mid}")
            if is_on_login_page(page):
                last_shot = take_screenshot(page, shots_dir, "l1-login")
                return "retry", "session dropped to /login during L1", last_shot
            if not _reload_renew_code_page(page):
                last_shot = take_screenshot(page, shots_dir, "l1-reload-fail")
                if is_on_login_page(page):
                    return "retry", "session dropped to /login on L1 reload", last_shot
                return "retry", "L1 reload /vps-renew-code failed", last_shot

        fill_ret = fill_renew_code_page(
            page, code, shots_dir=shots_dir, max_rounds=yolo_rounds
        )
        if fill_ret is True:
            ok, reason, shot = _wait_final_renew_result(page, shots_dir)
            if ok is True:
                return True, reason, shot
            if ok == "retry":
                # code rejected or login drop → escalate L2 (NEW bot code)
                if _code_reject_reason(reason or ""):
                    log_phase(
                        "L1",
                        f"TG code rejected by site — do NOT reuse msg={mid}; escalate L2",
                        "WARN",
                    )
                return "retry", reason, shot
            if ok is False:
                last_shot = shot
                last_reason = reason or last_reason
                # Token dead → never L1-reuse
                if _code_reject_reason(last_reason):
                    log_phase(
                        "L1",
                        f"code rejected ({last_reason}) — skip remaining L1, need new TG code",
                        "WARN",
                    )
                    return "retry", f"code rejected: {last_reason}", shot
                # math/other page fail: try L1 again if budget left
                if l1 < l1_retries and _code_page_ready(page):
                    log_phase("L1", f"submit failed ({reason}) — reload code page", "WARN")
                    continue
                return "retry", f"code-page submit failed: {reason}", shot
            # unclear banner
            last_shot = shot
            last_reason = reason or last_reason
            if _code_reject_reason(last_reason):
                return "retry", f"code rejected: {last_reason}", shot
            if l1 < l1_retries and _code_page_ready(page):
                continue
            return None, last_reason, last_shot

        if fill_ret == "off_page":
            last_shot = take_screenshot(page, shots_dir, "code-off-page")
            return (
                "retry",
                f"left renew-code page during fill url={_page_url(page)!r}",
                last_shot,
            )

        # fill_ret is False: math/yolo/click fail while (maybe) still on page
        last_shot = take_screenshot(page, shots_dir, f"fill-code-fail-l1-{l1}")
        last_reason = "Failed on renew-code page (code/math/yolo/submit)"
        if is_on_login_page(page):
            return "retry", "session dropped to /login during code fill", last_shot
        if l1 < l1_retries and _code_page_ready(page):
            log_phase("L1", "fill failed — reload + same TG code", "WARN")
            continue
        # L1 exhausted or not on code page → outer L2
        return "retry", f"{last_reason} (L1 exhausted)", last_shot

    return "retry", f"{last_reason} (L1 exhausted)", last_shot


def woiden_renew_yolo(shots_dir, tg_phone, api_id, api_hash, session_string="", session_file="", max_rounds=4):
    # max_rounds: 仅为调用方签名兼容保留，本函数体内不使用。
    # 注意 —— 这里确实有 reCAPTCHA（fill_renew_code_page 第 3/4 步就在解），
    # 只是它的轮次由 YOLO_RECAPTCHA_MAX_ROUNDS 决定（唯一解析点见
    # woiden_yolo/captcha.py:resolve_yolo_max_rounds），不走这个形参。
    # 想改轮次请改环境变量，改这个参数没有任何效果。
    page = None
    client = None
    _total_steps = 6
    try:
        run_start("Woiden renew")

        # 1. Initialize Pyrogram
        step_begin(1, _total_steps, "BROWSER", "pyrogram + chrome")
        t_step = time.time()
        if not api_id or not api_hash or (not session_string and not session_file):
            log("Missing Pyrogram credentials (TG_API_ID, TG_API_HASH, TG_SESSION_STRING or TG_SESSION_FILE)", "ERROR")
            run_end(False, "Missing Pyrogram credentials")
            return False, "Missing Pyrogram credentials", ""

        proxy_url = os.environ.get("TG_PROXY") or os.environ.get("TG_PROXY_URL") or os.environ.get("http_proxy") or ""
        proxy_dict = None
        if proxy_url:
            try:
                parsed = urlparse(proxy_url)
                proxy_dict = {
                    "scheme": parsed.scheme,
                    "hostname": parsed.hostname,
                    "port": parsed.port,
                }
                log(f"Configured Pyrogram proxy: {proxy_dict}")
            except Exception as e:
                log(f"Failed to parse proxy URL {proxy_url}: {e}", "WARN")

        log("Starting Pyrogram Client...")
        if session_string:
            client = Client(
                "WOIDEN_renew",
                api_id=int(api_id),
                api_hash=api_hash,
                session_string=session_string,
                proxy=proxy_dict,
                in_memory=True,
                no_updates=True,
                ipv6=True,
            )
        else:
            session_name = session_file.replace(".session", "") if session_file else "my_account"
            client = Client(
                session_name,
                api_id=int(api_id),
                api_hash=api_hash,
                proxy=proxy_dict,
                workdir=os.path.dirname(session_file) or ".",
                no_updates=True,
                ipv6=True,
            )

        client.start()
        log("Pyrogram connected successfully as real user.")

        # 2. Initialize Browser (keep user_data_dir for gentle close)
        page, user_data_dir, should_cleanup = create_browser()
        log(
            f"Browser ready profile={user_data_dir!r} cleanup={should_cleanup} "
            f"(cookies only persist if cleanup=False and quit is graceful)"
        )
        step_end("BROWSER", True, f"profile={user_data_dir!r}", time.time() - t_step)

        # 3. Login (Telegram widget + API Confirm) — ends on /vps-renew when OK
        step_begin(2, _total_steps, "LOGIN", "probe /vps-renew or TG widget")
        t_step = time.time()
        if not login_woiden(page, client, tg_phone):
            shot = take_screenshot(page, shots_dir, "login-fail")
            step_end("LOGIN", False, "TG widget failed", time.time() - t_step)
            run_end(False, "Login failed via Telegram Widget")
            return False, "Login failed via Telegram Widget", shot
        step_end("LOGIN", True, f"url={_page_url(page)!r}", time.time() - t_step)

        # 4. Already should be on /vps-renew from ensure_WOIDEN_site_session.
        #    Only re-open if form missing (no extra dashboard/login hops).
        if not (page.ele("#web_address", timeout=1) or page.ele("#form-submit", timeout=0.5)):
            log("Renew form not in view after login — open /vps-renew once")
            if not go_vps_renew(page):
                shot = take_screenshot(page, shots_dir, "renew-form-missing")
                run_end(False, "Renew form not found (#web_address)")
                return False, "Renew form not found (#web_address)", shot

        if not wait_for_renew_form(page, timeout=20):
            shot = take_screenshot(page, shots_dir, "renew-form-missing")
            run_end(False, "Renew form not found (#web_address)")
            return False, "Renew form not found (#web_address)", shot

        hide_ads(page)
        log("Filling renew form: website + agreement checkbox...")
        if not fill_renew_form(page):
            shot = take_screenshot(page, shots_dir, "renew-form-fill-fail")
            run_end(False, "Failed to fill renew form")
            return False, "Failed to fill renew form", shot

        # Woiden /vps-renew: image math captcha (Vision), usually NO Cloudflare Turnstile.
        # Flow: fill website + agreement → solve #captcha via AI → click Renew VPS.
        has_math = page_has_math_captcha(page)
        has_cf = page_has_turnstile(page)
        log(f"Renew gate: math_captcha={has_math} turnstile={has_cf}")
        step_begin(
            3,
            _total_steps,
            "RENEW",
            "math captcha + first Renew VPS" if has_math else "first Renew VPS",
        )
        t_step = time.time()
        turnstile_timeout = int(os.environ.get("WOIDEN_TURNSTILE_TIMEOUT", "120"))
        # Default 6: attempt 1 often burned by false "already logged in" on temp profile
        max_submit_attempts = int(os.environ.get("WOIDEN_RENEW_SUBMIT_ATTEMPTS", "6"))
        max_submit_attempts = max(3, min(max_submit_attempts, 12))
        ok = None
        reason = ""

        for attempt in range(1, max_submit_attempts + 1):
            log(f"Renew submit attempt {attempt}/{max_submit_attempts}")
            hide_ads(page)

            # Always force exact website value (JS replace, not append)
            if not fill_renew_form(page):
                shot = take_screenshot(page, shots_dir, "renew-form-fill-fail")
                return False, "Failed to fill renew form", shot

            # Sanity: reject doubled domain before submit
            try:
                web_now = page.run_js(
                    "const el=document.getElementById('web_address'); return el?el.value:'';"
                ) or ""
            except Exception:
                web_now = ""
            # count!=1 covers both missing and doubled "woiden.idwoiden.id"
            if str(web_now).count("woiden.id") != 1:
                log(f"web_address still wrong before submit: {web_now!r} — force set", "WARN")
                fill_renew_form(page, "woiden.id")

            # Main captcha: image math on /vps-renew (Vision). Prefer this over CF.
            if page_has_math_captcha(page):
                log("Solving renew-page image math captcha with Vision...")
                math_ok = False
                try:
                    math_ok = bool(solve_math_captcha_on_page(page, shots_dir=shots_dir))
                except Exception as e:
                    log(f"solve_math_captcha_on_page failed: {e}", "WARN")
                    math_ok = False
                if not math_ok:
                    if attempt < max_submit_attempts:
                        log("Math captcha unsolved — retry", "WARN")
                        try:
                            page.refresh()
                        except Exception:
                            go_vps_renew(page)
                        time.sleep(1.5)
                        continue
                    shot = take_screenshot(page, shots_dir, "math-captcha-fail")
                    return False, "Renew math captcha unsolved (need VISION_* for image digits)", shot
            elif page_has_turnstile(page):
                # Rare: if CF reappears, wait for token
                if not wait_turnstile_ready(page, timeout=turnstile_timeout, prefer_ui_success=True):
                    if attempt < max_submit_attempts:
                        log("Turnstile not ready — refresh and retry", "WARN")
                        refresh_turnstile(page)
                        continue
                    shot = take_screenshot(page, shots_dir, "turnstile-timeout")
                    return False, "Cloudflare Turnstile not solved in time", shot
            else:
                log("No math captcha and no Turnstile detected — submit bare form", "WARN")

            # Only ensure agreement still checked — do NOT retype website
            try:
                page.run_js(
                    "const a=document.querySelector(\"input[name='agreement']\");"
                    "if(a&&!a.checked){a.checked=true;"
                    "a.dispatchEvent(new Event('change',{bubbles:true}));}"
                )
            except Exception:
                pass

            # Math path: re-read #captcha right before click; if empty, abort this attempt.
            # Also wait a beat so server-side / client validation sees a settled field
            # (clicking instantly after fill often yields "Please solve Captcha correctly!"
            # even when Vision answer was right).
            if page_has_math_captcha(page):
                try:
                    cap_now = page.run_js(
                        "const el=document.getElementById('captcha')"
                        "||document.querySelector(\"input[name='captcha']\");"
                        "return el?String(el.value||'').trim():'';"
                    ) or ""
                except Exception:
                    cap_now = ""
                if not re.sub(r"\D", "", str(cap_now)):
                    log(f"#captcha empty right before Renew (dom={cap_now!r}) — re-solve", "WARN")
                    if attempt < max_submit_attempts:
                        try:
                            page.refresh()
                        except Exception:
                            go_vps_renew(page)
                        time.sleep(1.5)
                        continue
                    shot = take_screenshot(page, shots_dir, "math-captcha-empty-preclick")
                    return False, "Math captcha empty before Renew click", shot
                pre_click_wait = float(os.environ.get("WOIDEN_RENEW_PRECLICK_SEC", "2.8") or "2.8")
                pre_click_wait = max(1.2, min(pre_click_wait, 8.0))
                log(f"Pre-Renew settle {pre_click_wait:.1f}s (captcha={cap_now!r}) — slow click path")
                time.sleep(pre_click_wait)
            else:
                time.sleep(1.0)

            # Session may die mid-flow → bounced to /login. Do NOT wait empty #response.
            if is_on_login_page(page) or not is_WOIDEN_logged_in(page):
                log(
                    f"Session lost before Renew click (url={_page_url(page)!r}) — re-login",
                    "WARN",
                )
                if not login_woiden(page, client, tg_phone):
                    shot = take_screenshot(page, shots_dir, "relogin-fail")
                    return False, "Re-login failed after session drop", shot
                if attempt < max_submit_attempts:
                    continue
                return False, "Re-login ok but out of renew attempts", take_screenshot(
                    page, shots_dir, "relogin-ok-no-attempts"
                )

            if not click_renew_button(page):
                # Button may vanish if page navigated to login during click
                if is_on_login_page(page):
                    log("Renew button gone + on /login — re-login then retry", "WARN")
                    if not login_woiden(page, client, tg_phone):
                        shot = take_screenshot(page, shots_dir, "relogin-fail")
                        return False, "Re-login failed after renew-btn missing", shot
                    if attempt < max_submit_attempts:
                        continue
                shot = take_screenshot(page, shots_dir, "renew-btn-missing")
                return False, "Renew VPS button not found/clicked", shot

            log("Waiting after Renew click for INPUT RENEW CODE / result...")
            time.sleep(2.5)
            hide_ads(page)
            empty_ticks = 0
            ok, reason = None, ""
            session_dropped = False
            # Wait longer for AJAX — don't re-click at 6s (that was thrashing)
            for i in range(35):
                hide_ads(page)

                # CRITICAL: dropped to /login → stop waiting empty renew UI, re-login
                if is_on_login_page(page):
                    log(
                        f"Dropped to /login after Renew (t={i+1}s url={_page_url(page)!r}) "
                        f"— leave wait loop and re-login "
                        f"(cookie→Log in as / no-cookie→phone)",
                        "WARN",
                    )
                    ok, reason = "retry", "session dropped to /login"
                    session_dropped = True
                    break

                if page_has_input_renew_code(page):
                    ok, reason = "need_code", "verification code sent to telegram"
                    log("Detected INPUT RENEW CODE UI after first Renew")
                    break
                ok, reason = renew_result_from_page(page)
                if ok in (True, False, "need_code", "retry"):
                    break
                if not reason:
                    empty_ticks += 1
                    if empty_ticks in (1, 5, 12):
                        st = post_renew_ui_state(page)
                        log(f"Post-renew UI state @ {i+1}s: {st!r}")
                        # state may reveal login bounce
                        try:
                            st_url = (st or {}).get("url") or ""
                            if "/login" in str(st_url).lower():
                                log("Post-renew state shows /login — re-login", "WARN")
                                ok, reason = "retry", "session dropped to /login"
                                session_dropped = True
                                break
                        except Exception:
                            pass
                    # Single re-click only once, late, if token still long AND still logged in
                    if empty_ticks == 14:
                        if is_on_login_page(page):
                            ok, reason = "retry", "session dropped to /login"
                            session_dropped = True
                            break
                        tlen = turnstile_token_len(page)
                        if tlen < 200:
                            log(
                                f"No response and token short (len={tlen}) — "
                                "treat as turnstile fail, next attempt",
                                "WARN",
                            )
                            ok, reason = "retry", "silent submit + weak token"
                            break
                        log(
                            f"No response after 14s — ONE re-click only "
                            f"(token len={tlen}, no form.submit)"
                        )
                        try:
                            page.run_js(
                                "const a=document.querySelector(\"input[name='agreement']\");"
                                "if(a){a.checked=true;}"
                            )
                        except Exception:
                            pass
                        click_renew_button(page)
                if i % 5 == 4:
                    log(f"… still waiting post-renew UI ({i+1}s): {str(reason)[:120]!r}")
                time.sleep(1)

            if session_dropped or (
                isinstance(reason, str) and "session dropped to /login" in reason.lower()
            ):
                log_phase("SESSION", "dropped to /login after Renew — re-login", "WARN")
                log(
                    "Re-login after session drop "
                    "(login_woiden: Log-in-as if cookie warm, else phone OAuth)",
                    "WARN",
                )
                if not login_woiden(page, client, tg_phone):
                    shot = take_screenshot(page, shots_dir, "relogin-fail")
                    step_end("RENEW", False, "re-login failed", time.time() - t_step)
                    run_end(False, "Re-login failed after session drop")
                    return False, "Re-login failed after session drop", shot
                if attempt < max_submit_attempts:
                    # Back on renew form with session — retry fill/turnstile/renew
                    continue
                shot = take_screenshot(page, shots_dir, "relogin-ok-no-attempts")
                step_end("RENEW", False, "out of renew attempts", time.time() - t_step)
                run_end(False, "Re-login ok but out of renew attempts")
                return False, "Re-login ok but out of renew attempts", shot

            reason_l = (reason or "").lower() if isinstance(reason, str) else ""
            is_fatal_error = any(
                m in reason_l
                for m in (
                    "already renewed",
                    "already renew",
                    "not found",
                    "suspended",
                    "not eligible",
                    "limit reached",
                )
            )
            
            if ok == "retry" or (ok is False and not is_fatal_error):
                log(f"Site rejected submission (attempt {attempt}): {reason!r} — refresh and retry", "WARN")
                try:
                    page.run_js(
                        "const r=document.getElementById('response'); if(r) r.innerHTML='';"
                    )
                except Exception:
                    pass
                # If we got bounced to login, re-login first
                if is_on_login_page(page):
                    if not login_woiden(page, client, tg_phone):
                        shot = take_screenshot(page, shots_dir, "relogin-fail")
                        step_end("RENEW", False, "re-login after validation", time.time() - t_step)
                        run_end(False, "Re-login failed after validation retry")
                        return False, "Re-login failed after validation retry", shot
                # Captcha wrong: new image digits only load after refresh / re-open renew.
                # Turnstile rare path still needs refresh_turnstile.
                if page_has_turnstile(page):
                    refresh_turnstile(page)
                if attempt < max_submit_attempts:
                    try:
                        if not is_on_login_page(page):
                            # Force a fresh renew form so math captcha images rotate
                            page.run_js("location.assign('https://woiden.id/vps-renew');")
                        time.sleep(2)
                        hide_ads(page)
                    except Exception:
                        pass
                    continue
                shot = take_screenshot(page, shots_dir, "renew-validation-failed")
                step_end("RENEW", False, reason or "validation failed", time.time() - t_step)
                run_end(False, f"Renew failed: {reason}")
                return False, f"Renew failed: {reason}", shot

            # success / need_code / hard fail / unclear → leave retry loop
            break

        if ok is True:
            log(f"Renew success (no code step): {reason}")
            shot = take_screenshot(page, shots_dir, "renew-success")
            step_end("RENEW", True, reason or "success no code step", time.time() - t_step)
            run_end(True, reason or "renewed")
            return True, reason, shot

        if ok is False:
            log(f"Renew failed after first click: {reason}", "ERROR")
            shot = take_screenshot(page, shots_dir, "renew-fail")
            step_end("RENEW", False, reason or "fail", time.time() - t_step)
            run_end(False, f"Renew failed: {reason}")
            return False, f"Renew failed: {reason}", shot

        step_end(
            "RENEW",
            ok == "need_code" or page_has_input_renew_code(page),
            reason or ("need_code" if ok == "need_code" else "unclear"),
            time.time() - t_step,
        )

        # 8. Intermediate: TG code → /vps-renew-code → #code + math + YOLO + final Renew
        #
        # Layers (host2play-style fail-fast + re-run):
        #   L1 — inside handle_post_renew_code_flow: reload code page, REUSE code
        #   L2 — re-click first Renew → NEW bot code (WOIDEN_CODE_L2_RETRIES default 5)
        #        also WOIDEN_CODE_OPEN_RETRIES as alias for backward compat
        #   L3 — dropped to /login → login_woiden then continue L2
        l2_retries = int(
            os.environ.get("WOIDEN_CODE_L2_RETRIES")
            or os.environ.get("WOIDEN_CODE_OPEN_RETRIES")
            or "5"
        )
        l2_retries = max(1, l2_retries)
        if ok == "need_code" or page_has_input_renew_code(page):
            step_begin(4, _total_steps, "CODE_PAGE", f"L1 reuse code / L2 max={l2_retries}")
            t_code = time.time()
            loop = _event_loop()
            # First attempt: accept latest bot code already in chat (require_newer=False)
            bot_since = {}
            require_newer = False
            last_code_shot = None
            last_code_reason = ""

            for code_try in range(1, l2_retries + 1):
                log_phase(
                    "L2",
                    f"try {code_try}/{l2_retries} require_newer={int(require_newer)}",
                )
                log(
                    f"Post-renew step L2 {code_try}/{l2_retries}: "
                    f"Telegram code → renew-code "
                    f"(require_newer={int(require_newer)} since={bot_since})"
                )

                # L3: session gone → re-login before code flow
                if is_on_login_page(page) or not is_WOIDEN_logged_in(page):
                    log_phase(
                        "L3",
                        f"session lost before code flow url={_page_url(page)!r}",
                        "WARN",
                    )
                    log(
                        f"L3: session lost before code flow "
                        f"(url={_page_url(page)!r}) — re-login",
                        "WARN",
                    )
                    if not login_woiden(page, client, tg_phone):
                        shot = take_screenshot(page, shots_dir, "l3-relogin-fail")
                        step_end("CODE_PAGE", False, "L3 re-login failed", time.time() - t_code)
                        run_end(False, "L3 re-login failed before code flow")
                        return False, "L3 re-login failed before code flow", shot
                    # After re-login we are usually on /vps-renew form — need L2 re-Renew
                    # for a fresh INPUT RENEW CODE (old code page may be stale).
                    bot_since = loop.run_until_complete(snapshot_woiden_bot_msg_ids(client))
                    require_newer = True
                    try:
                        page.run_js("location.assign('https://woiden.id/vps-renew');")
                    except Exception:
                        try:
                            page.get("https://woiden.id/vps-renew")
                        except Exception:
                            pass
                    time.sleep(2)
                    hide_ads(page)
                    if not fill_renew_form(page):
                        continue
                    if page_has_math_captcha(page):
                        log("L3→L2: Solving renew-page image math captcha...")
                        try:
                            solve_math_captcha_on_page(page, shots_dir=shots_dir)
                        except Exception as e:
                            log(f"L3→L2 solve_math_captcha_on_page failed: {e}", "WARN")
                        time.sleep(1.5)
                    refresh_turnstile(page)
                    if not wait_turnstile_ready(
                        page, timeout=turnstile_timeout, prefer_ui_success=True
                    ):
                        refresh_turnstile(page)
                        continue
                    try:
                        page.run_js(
                            "const a=document.querySelector(\"input[name='agreement']\");"
                            "if(a){a.checked=true;}"
                        )
                    except Exception:
                        pass
                    time.sleep(1.0)
                    if not click_renew_button(page):
                        continue
                    got_btn = False
                    for _w in range(35):
                        hide_ads(page)
                        if page_has_input_renew_code(page):
                            got_btn = True
                            log("L3→L2: Fresh INPUT RENEW CODE after re-login re-Renew")
                            break
                        rok, rreason = renew_result_from_page(page)
                        if rok is True:
                            step_end("CODE_PAGE", True, rreason or "ok", time.time() - t_code)
                            run_end(True, rreason or "renewed")
                            return True, rreason, take_screenshot(
                                page, shots_dir, "renew-success"
                            )
                        if rok is False and "validation failed" not in str(rreason).lower():
                            break
                        time.sleep(1)
                    if not got_btn:
                        log("L3→L2: re-Renew did not produce INPUT RENEW CODE", "WARN")
                        continue

                code_ok, code_reason, code_shot = handle_post_renew_code_flow(
                    page,
                    client,
                    shots_dir,
                    since_ids=bot_since,
                    require_newer=require_newer,
                )
                last_code_shot = code_shot
                last_code_reason = code_reason or last_code_reason

                if code_ok is True:
                    log(f"Renew success after code: {code_reason}")
                    step_end("CODE_PAGE", True, code_reason or "ok", time.time() - t_code)
                    run_end(True, code_reason or "renewed after code")
                    return (
                        True,
                        code_reason,
                        code_shot or take_screenshot(page, shots_dir, "renew-success"),
                    )

                need_l2 = code_ok == "retry" or (
                    isinstance(code_reason, str)
                    and (
                        "open /vps-renew-code" in code_reason.lower()
                        or "missing #code" in code_reason.lower()
                        or "input renew code" in code_reason.lower()
                        or "l1 exhausted" in code_reason.lower()
                        or "left renew-code" in code_reason.lower()
                        or "code rejected" in code_reason.lower()
                        or "session dropped to /login" in code_reason.lower()
                        or "new renew code not received" in code_reason.lower()
                    )
                )

                if need_l2:
                    log_phase("L2", f"escalate ({code_reason}) try={code_try}/{l2_retries}", "WARN")
                    log(
                        f"L2 escalate ({code_reason}) — "
                        f"re-run first Renew for a NEW bot code "
                        f"({code_try}/{l2_retries})",
                        "WARN",
                    )
                    if code_try >= l2_retries:
                        step_end(
                            "CODE_PAGE",
                            False,
                            f"L2 exhausted: {code_reason}",
                            time.time() - t_code,
                        )
                        run_end(False, f"L2 exhausted after {l2_retries}: {code_reason}")
                        return (
                            False,
                            f"Renew code flow failed after {l2_retries} L2 retries: "
                            f"{code_reason}",
                            code_shot,
                        )

                    # Snapshot bot msg ids BEFORE re-Renew so we only accept new codes
                    bot_since = loop.run_until_complete(snapshot_woiden_bot_msg_ids(client))
                    require_newer = True

                    # L3 if already on login
                    if is_on_login_page(page):
                        log("L3: on /login before L2 re-Renew — re-login", "WARN")
                        if not login_woiden(page, client, tg_phone):
                            shot = take_screenshot(page, shots_dir, "l3-relogin-fail")
                            return False, "L3 re-login failed before L2 re-Renew", shot

                    try:
                        page.run_js("location.assign('https://woiden.id/vps-renew');")
                    except Exception:
                        try:
                            page.get("https://woiden.id/vps-renew")
                        except Exception:
                            pass
                    time.sleep(2)
                    hide_ads(page)

                    if is_on_login_page(page):
                        log("L3: bounced to /login on vps-renew nav — re-login", "WARN")
                        if not login_woiden(page, client, tg_phone):
                            shot = take_screenshot(page, shots_dir, "l3-relogin-fail")
                            return False, "L3 re-login failed after vps-renew nav", shot

                    if not fill_renew_form(page):
                        continue
                    if page_has_math_captcha(page):
                        log("L2: Solving renew-page image math captcha...")
                        try:
                            solve_math_captcha_on_page(page, shots_dir=shots_dir)
                        except Exception as e:
                            log(f"L2 solve_math_captcha_on_page failed: {e}", "WARN")
                        time.sleep(1.5)
                    refresh_turnstile(page)
                    if not wait_turnstile_ready(
                        page, timeout=turnstile_timeout, prefer_ui_success=True
                    ):
                        refresh_turnstile(page)
                        continue
                    try:
                        page.run_js(
                            "const a=document.querySelector(\"input[name='agreement']\");"
                            "if(a){a.checked=true;}"
                        )
                    except Exception:
                        pass
                    time.sleep(1.0)
                    if not click_renew_button(page):
                        continue
                    # wait for green INPUT RENEW CODE again
                    got_btn = False
                    for _w in range(35):
                        hide_ads(page)
                        if is_on_login_page(page):
                            log("Dropped to /login waiting INPUT RENEW CODE", "WARN")
                            break
                        if page_has_input_renew_code(page):
                            got_btn = True
                            log("L2: Fresh INPUT RENEW CODE after re-Renew")
                            break
                        rok, rreason = renew_result_from_page(page)
                        if rok is True:
                            step_end("CODE_PAGE", True, rreason or "ok", time.time() - t_code)
                            run_end(True, rreason or "renewed")
                            return True, rreason, take_screenshot(
                                page, shots_dir, "renew-success"
                            )
                        if rok is False and "validation failed" not in str(rreason).lower():
                            break
                        time.sleep(1)
                    if not got_btn:
                        log("L2: Re-Renew did not produce INPUT RENEW CODE", "WARN")
                        continue
                    continue  # handle_post_renew_code_flow again with require_newer

                if code_ok is False:
                    log(f"Renew code flow failed: {code_reason}", "ERROR")
                    step_end("CODE_PAGE", False, code_reason or "fail", time.time() - t_code)
                    run_end(False, f"Renew code flow failed: {code_reason}")
                    return False, f"Renew code flow failed: {code_reason}", code_shot

                # unclear — try L2 if budget remains, else fail
                log(f"Code flow unclear ({code_reason}) — escalate L2 if budget", "WARN")
                if code_try >= l2_retries:
                    step_end(
                        "CODE_PAGE",
                        False,
                        f"unclear after L2: {code_reason}",
                        time.time() - t_code,
                    )
                    run_end(False, f"unclear after {l2_retries} L2: {code_reason}")
                    return (
                        False,
                        f"Code flow finished unclear after {l2_retries} L2: {code_reason}",
                        code_shot or take_screenshot(page, shots_dir, "renew-unknown"),
                    )
                bot_since = loop.run_until_complete(snapshot_woiden_bot_msg_ids(client))
                require_newer = True
                try:
                    page.run_js("location.assign('https://woiden.id/vps-renew');")
                except Exception:
                    try:
                        page.get("https://woiden.id/vps-renew")
                    except Exception:
                        pass
                time.sleep(2)
                hide_ads(page)
                if not fill_renew_form(page):
                    continue
                refresh_turnstile(page)
                if not wait_turnstile_ready(
                    page, timeout=turnstile_timeout, prefer_ui_success=True
                ):
                    continue
                try:
                    page.run_js(
                        "const a=document.querySelector(\"input[name='agreement']\");"
                        "if(a){a.checked=true;}"
                    )
                except Exception:
                    pass
                time.sleep(1.0)
                if not click_renew_button(page):
                    continue
                for _w in range(35):
                    hide_ads(page)
                    if page_has_input_renew_code(page):
                        break
                    time.sleep(1)
                continue

            step_end(
                "CODE_PAGE",
                False,
                f"L2 exhausted: {last_code_reason}",
                time.time() - t_code,
            )
            run_end(False, f"L2 exhausted: {last_code_reason}")
            return (
                False,
                f"Renew code flow failed after {l2_retries} L2 retries: {last_code_reason}",
                last_code_shot,
            )

        shot = take_screenshot(page, shots_dir, "renew-unknown")
        run_end(False, f"Submit done, unclear result: {reason}")
        return False, f"Submit done, unclear result: {reason}", shot

    except Exception as e:
        log(f"woiden_renew_yolo exception: {e}", "ERROR")
        try:
            run_end(False, f"exception: {e}")
        except Exception:
            pass
        if page:
            shot = take_screenshot(page, shots_dir, "exception")
            return False, str(e), shot
        return False, str(e), ""
    finally:
        if page:
            # Pass profile path + cleanup flag so temp profiles are removed,
            # while persistent profiles get a graceful quit (cookies flush).
            try:
                close_browser(page, user_data_dir, should_cleanup)
            except NameError:
                close_browser(page)
        if client and getattr(client, "is_connected", False):
            try:
                client.stop()
            except Exception:
                pass


def take_screenshot(page, screenshot_dir, suffix):
    os.makedirs(screenshot_dir, exist_ok=True)
    name = f"Woiden-{suffix}-{int(time.time())}.png"
    path = os.path.join(screenshot_dir, name)
    try:
        page.get_screenshot(path=path)
        return path
    except Exception as e:
        log(f"screenshot failed: {e}", "WARN")
        return ""
