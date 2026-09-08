import os


def force_loopback_direct():
    entries = [
        entry.strip()
        for entry in (os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or "").split(",")
        if entry.strip()
    ]
    for host in ("localhost", "127.0.0.1", "::1"):
        if host not in entries:
            entries.append(host)
    value = ",".join(entries)
    os.environ["NO_PROXY"] = value
    os.environ["no_proxy"] = value


def launch_browser():
    force_loopback_direct()
    try:
        from ruyipage import launch
    except Exception as exc:
        raise RuntimeError(f"Failed to import ruyipage: {exc}") from exc

    browser_path = (os.environ.get("BROWSER_RUYI_PATH") or "/opt/ruyipage-firefox/firefox").strip()
    user_dir = (os.environ.get("BROWSER_USER_DATA_DIR") or "").strip()
    proxy_mode = (os.environ.get("BROWSER_PROXY_MODE") or "launch").strip()
    proxy_value = (os.environ.get("BROWSER_PROXY_VALUE") or os.environ.get("BROWSER_PROXY") or "").strip()
    fpfile = (os.environ.get("BROWSER_RUYI_FPFILE") or "").strip()
    headless = (os.environ.get("BROWSER_HEADLESS") or "false").strip().lower() in {"1", "true", "yes", "on"}

    kwargs = {
        "headless": headless,
        "close_on_exit": True,
        "allow_system_access": True,
    }
    if browser_path:
        kwargs["browser_path"] = browser_path
    if user_dir:
        kwargs["user_dir"] = user_dir
    if proxy_value and proxy_mode not in {"direct", "ruyi_fpfile"}:
        kwargs["proxy"] = proxy_value
    if proxy_mode == "ruyi_fpfile" and fpfile:
        kwargs["fpfile"] = fpfile

    page = launch(**kwargs)
    locale = (os.environ.get("BROWSER_LOCALE") or "").strip()
    timezone = (os.environ.get("BROWSER_TIMEZONE") or "").strip()
    if locale:
        page.emulation.set_locale(locale)
    if timezone:
        page.emulation.set_timezone(timezone)
    return page
